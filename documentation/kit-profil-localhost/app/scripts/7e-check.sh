#!/usr/bin/env bash
# Vérifie en localhost les 35 critères de la grille 12 facteurs × 7E.
# usage : scripts/7e-check.sh dev|prod [--exercice] [ID ...]
#   sans ID     : les 35 critères, dans l'ordre de la grille
#   --exercice  : ajoute les épreuves qui agissent sur l'environnement, toutes réversibles :
#                 2.2 build depuis un clone vierge, 5.3 retour arrière (prod),
#                 8.1 réplique supplémentaire, 9.1 et 9.2 arrêt puis redémarrage d'une réplique
# sortie : une ligne JSON par critère sur stdout : {"id", "statut", "preuve"}
#   ok          vérifié automatiquement : score 3 si la vérification tourne à chaque cycle
#   ecart       à noter 0 ou 1 par l'auditeur
#   manuel      preuve humaine attendue ; « preuve » donne la procédure
#   calibrage   seuil pas encore fixé : la mesure est donnée, sans verdict
#   sans_objet  hors calcul
# code de sortie : 1 si au moins un écart, 0 sinon.
# shellcheck disable=SC2016,SC2317  # programmes jq entre apostrophes ; fonctions c_* appelées par leur nom
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need docker git jq curl

ENV="${1:-}"
env_valide "$ENV"
shift
EXERCICE=false
if [[ "${1:-}" == --exercice ]]; then EXERCICE=true; shift; fi
cd "$RACINE"

GITLEAKS_IMAGE="${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.30.1}"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.75.0}"
LOKI_URL="${LOKI_URL:-http://127.0.0.1:3100}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
SERVICES_ATTACHES="${SERVICES_ATTACHES:-DATABASE_URL REDIS_URL SMTP_URL}"

TOUS=(1.1 1.2 2.1 2.2 3.1 3.2 4.1 4.2 5.1 5.2 5.3 12.1 12.2 6.1 6.2 7.1 7.2 11.1 11.2
      8.1 8.2 9.1 9.2 9.3 10.1 10.2 10.3 EX.1 EX.2 EV.1 EV.2 EQ.1 EQ.2 IN.1 FR.1)
if [[ $# -gt 0 ]]; then IDS=("$@"); else IDS=("${TOUS[@]}"); fi

TAG_PROD="$(etat_lire prod.tag || true)"
CFG="$(compose "$ENV" config --format json)" || die "configuration $ENV invalide"
CFG_PROD="$(DEPLOY_TAG="${TAG_PROD:-verification}" compose prod config --format json)" || die "configuration prod invalide"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# --- outils ------------------------------------------------------------------
res()   { jq -nc --arg id "$1" --arg s "$2" --arg p "$3" '{id: $id, statut: $s, preuve: $p}'; }
liste() { local out="" x; for x in "$@"; do out+="${out:+ ; }$x"; done; printf '%s' "$out"; }
# verdict ID PREUVE_SI_OK [ECART ...] : ok si aucun écart n'est passé
verdict() { local id="$1" ok="$2"; shift 2; if (( $# == 0 )); then res "$id" ok "$ok"; else res "$id" ecart "$(liste "$@")"; fi; }
compter() { grep -c . || true; }
cles()  { grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | tr -d '=' | sort -u; }
suivi() { local d="$1" l; shift; for l in "$@"; do git ls-files --error-unmatch "$d/$l" >/dev/null 2>&1 && return 0; done; return 1; }
http_port() { jq -r '.services.proxy.ports[0].published // empty' <<<"$CFG"; }
via_proxy() { curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$(http_port)$HEALTH_PATH" || true; }
image_id()  { local c; c="$(conteneurs "$1" "$2" | head -n 1 || true)"; [[ -z "$c" ]] || docker inspect -f '{{.Image}}' "$c"; }
echelle()   { compose "$ENV" up -d --no-deps --scale "web=$1" --wait web >/dev/null 2>&1; }

# --- Éléments : 1 Codebase, 2 Dépendances ---------------------------------------
c_1_1() {
  if [[ "$ENV" == dev ]]; then
    res 1.1 sans_objet "le dev exécute l'arbre de travail ($(git rev-parse --short HEAD)) : critère jugé sur la prod locale"
    return
  fi
  local r e=()
  r="$(revision prod web)"
  if [[ -z "$r" ]]; then res 1.1 ecart "aucun web en service, ou image sans label org.opencontainers.image.revision"; return; fi
  git cat-file -e "$r^{commit}" 2>/dev/null || e+=("web exécute $r, commit inconnu du dépôt")
  [[ "$r" == "$TAG_PROD" ]] || e+=("web exécute $r, l'état local annonce ${TAG_PROD:-rien}")
  verdict 1.1 "web exécute $r : commit du dépôt unique, release en service connue" "${e[@]}"
}

c_1_2() {
  res 1.2 manuel "montrer la dépendance déclarée vers la bibliothèque commune (registre de paquets Gitea, version épinglée) et l'absence de copie du code"
}

c_2_1() {
  local f d e=() n=0
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    n=$((n + 1)); d="$(dirname "$f")"
    case "${f##*/}" in
      package.json)   suivi "$d" package-lock.json pnpm-lock.yaml yarn.lock || e+=("$f sans fichier de verrouillage") ;;
      composer.json)  suivi "$d" composer.lock || e+=("$f sans composer.lock") ;;
      pyproject.toml) suivi "$d" uv.lock poetry.lock pdm.lock requirements.txt || e+=("$f sans verrouillage") ;;
      pom.xml)
        if grep -qE '<version>[[:space:]]*[[(]|-SNAPSHOT</version>|<version>(LATEST|RELEASE)</version>' "$f"; then
          e+=("$f : plage de versions ou SNAPSHOT")
        fi ;;
    esac
  done < <(git ls-files -- '*package.json' '*composer.json' '*pyproject.toml' '*pom.xml' | grep -v 'node_modules/' || true)
  if (( n == 0 )); then res 2.1 sans_objet "aucun manifeste de dépendances reconnu"; return; fi
  verdict 2.1 "$n manifeste(s), chacun verrouillé et versionné" "${e[@]}"
}

c_2_2() {
  if ! $EXERCICE; then
    res 2.2 manuel "épreuve longue : relancer avec --exercice (build sans cache depuis un clone vierge) ; la CI la rejoue à chaque commit"
    return
  fi
  local tag="7e-epreuve-2-2:$$"
  git clone -q --no-local "$RACINE" "$TMPD/clone"
  if docker build -q --no-cache --pull -t "$tag" "$TMPD/clone" >/dev/null 2>&1; then
    docker image rm -f "$tag" >/dev/null 2>&1 || true
    res 2.2 ok "épreuve : build réussi sans cache depuis un clone vierge du dépôt"
  else
    res 2.2 ecart "épreuve : le build échoue depuis un clone vierge (dépendance à l'hôte ou fichier non versionné)"
  fi
}

# --- Espace : 3 Config, 4 Services externes -------------------------------------
c_3_1() {
  local f d e=()
  git ls-files --error-unmatch .env.example >/dev/null 2>&1 || e+=(".env.example non versionné")
  for f in .env.dev .env.prod; do
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then e+=("$f est versionné"); fi
    git check-ignore -q "$f" || e+=("$f non ignoré par Git")
  done
  if [[ -f ".env.$ENV" ]]; then
    d="$(diff <(cles .env.example) <(cles ".env.$ENV") | grep -E '^[<>]' | tr '\n' ' ' || true)"
    [[ -z "$d" ]] || e+=("clés différentes entre .env.example et .env.$ENV : $d")
  fi
  verdict 3.1 "contrat .env.example versionné, copies ignorées, mêmes clés ; compose refuse toute variable requise absente" "${e[@]}"
}

c_3_2() {
  local e=() img
  if ! docker run --rm -v "$RACINE:/depot:ro" "$GITLEAKS_IMAGE" git --no-banner --redact --log-opts=--all /depot \
       >"$TMPD/gitleaks.log" 2>&1; then
    e+=("gitleaks : $(grep -oE 'leaks found: [0-9]+' "$TMPD/gitleaks.log" || echo 'exécution impossible') (historique, toutes branches)")
  fi
  img="$(jq -r '.services.web.image' <<<"$CFG")"
  if docker image inspect "$img" >/dev/null 2>&1; then
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$TRIVY_IMAGE" \
      image --scanners secret --exit-code 1 --quiet "$img" >/dev/null 2>&1 || e+=("trivy : secret dans l'image $img")
  fi
  verdict 3.2 "aucun secret dans l'historique Git (gitleaks, toutes branches) ni dans l'image $img (trivy)" "${e[@]}"
}

c_4_1() {
  local e=() v dur
  for v in $SERVICES_ATTACHES; do
    jq -e --arg v "$v" '.services.web.environment[$v] // "" | length > 0' <<<"$CFG" >/dev/null || e+=("$v absente de l'environnement de web")
  done
  dur="$(git grep -lE '\b(db|cache|mailpit):[0-9]{2,5}\b' -- . ':!compose*.yaml' ':!.env.example' ':!*.md' ':!7e/' ':!scripts/' 2>/dev/null \
    | head -n 3 | tr '\n' ' ' || true)"
  [[ -z "$dur" ]] || e+=("adresses de services en dur dans : $dur")
  verdict 4.1 "services attachés désignés par URL ($SERVICES_ATTACHES), aucune adresse en dur dans le code" "${e[@]}"
}

c_4_2() {
  res 4.2 manuel "dans .env.$ENV, pointer DATABASE_URL (ou REDIS_URL) vers une autre instance, puis scripts/compose.sh $ENV up -d --wait : même image, même code, application saine"
}

# --- Engendrent : 5 Build, release, run ; 12 Processus d'admin ------------------
c_5_1() {
  local e=() b
  b="$(jq -r '[.services | to_entries[] | select(.value.build != null) | .key] | join(" ")' <<<"$CFG_PROD")"
  [[ -z "$b" ]] || e+=("la prod locale construit au lancement : $b")
  if grep -qE '(npm|pnpm|yarn) (install|ci)|composer install|pip install|mvn |gradle ' bin/run 2>/dev/null; then
    e+=("bin/run installe ou construit au démarrage")
  fi
  verdict 5.1 "prod sans build : images publiées par la CI, rien de construit au démarrage" "${e[@]}"
}

c_5_2() {
  if [[ -z "$TAG_PROD" ]]; then res 5.2 manuel "aucune release déployée : scripts/deploy.sh <commit>"; return; fi
  local e=() images sans_tag latest
  images="$(DEPLOY_TAG="$TAG_PROD" compose prod config --images)"
  sans_tag="$(grep -vE ':[^/:]+$' <<<"$images" | tr '\n' ' ' || true)"
  latest="$(grep -E ':latest$' <<<"$images" | tr '\n' ' ' || true)"
  [[ -z "$sans_tag" ]] || e+=("images sans tag : $sans_tag")
  [[ -z "$latest" ]] || e+=("images en latest : $latest")
  [[ "$TAG_PROD" =~ ^[0-9a-f]{40}$ ]] || e+=("tag de l'application qui n'est pas un commit : $TAG_PROD")
  verdict 5.2 "images de la prod toutes épinglées ; l'application porte le commit $TAG_PROD" "${e[@]}"
}

c_5_3() {
  if [[ "$ENV" != prod ]]; then res 5.3 sans_objet "le retour arrière se juge sur la prod locale"; return; fi
  local cible avant="$TAG_PROD" r=ok
  cible="$(cible_retour_arriere "$TAG_PROD")"
  if [[ -z "$cible" ]]; then res 5.3 ecart "aucune release antérieure saine en mémoire : retour arrière impossible"; return; fi
  if ! $EXERCICE; then
    if docker image inspect "$(image_app "$cible")" >/dev/null 2>&1; then
      res 5.3 manuel "cible de retour arrière prête ($cible, image présente) ; l'éprouver avec --exercice"
    else
      res 5.3 ecart "image de la release $cible absente du poste : retour arrière lent ou impossible hors ligne"
    fi
    return
  fi
  # Épreuve : redéployer la release antérieure, puis revenir à la release en service.
  "$RACINE/scripts/deploy.sh" "$cible" >&2 || r=echec
  [[ "$(revision prod web)" == "$cible" ]] || r=echec
  "$RACINE/scripts/deploy.sh" "$avant" >&2 || r=echec
  [[ "$(revision prod web)" == "$avant" ]] || r=echec
  memoire_evenement prod "$(jq -nc --arg r "$r" --arg c "$cible" '{type: "epreuve", critere: "5.3", resultat: $r, cible: $c}')"
  if [[ "$r" == ok ]]; then res 5.3 ok "épreuve : passage à $cible puis retour à $avant, chacun sain"
  else res 5.3 ecart "épreuve de retour arrière en échec (détail dans la mémoire prod)"; fi
}

c_12_1() {
  local dernier
  dernier="$(evenements "$ENV" | jq -cs '[.[] | select(.type == "admin")] | last // empty')"
  if [[ -z "$dernier" ]]; then
    res 12.1 manuel "aucune tâche d'admin tracée : les lancer par scripts/admin.sh $ENV <commande>"
    return
  fi
  res 12.1 ok "tâches d'admin lancées depuis l'image et la config de $ENV, tracées (dernière : $(jq -r '"\(.commande) sur \(.release)"' <<<"$dernier"))"
}

c_12_2() {
  if ! grep -q 'migrations-check)' bin/run 2>/dev/null; then
    res 12.2 manuel "bin/run ne définit pas migrations-check : contrôler la table des migrations à la main"
    return
  fi
  if compose "$ENV" run --rm -T --no-deps web migrations-check >/dev/null 2>&1; then
    res 12.2 ok "schéma conforme aux migrations versionnées (bin/run migrations-check)"
  else
    res 12.2 ecart "migrations en attente ou contrôle impossible : scripts/admin.sh $ENV migrate"
  fi
}

# --- État : 6 Processus sans état ------------------------------------------------
c_6_1() {
  local e=() s c n=0
  for s in "${APP_SERVICES[@]}"; do
    for c in $(conteneurs "$ENV" "$s"); do
      n=$((n + 1))
      [[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$c")" == true ]] || e+=("$s : système de fichiers inscriptible")
    done
  done
  (( n > 0 )) || e+=("aucun conteneur applicatif en service")
  if grep -qE '^[[:space:]]*(ip_hash|sticky|hash[[:space:]]+\$cookie)' proxy/default.conf; then e+=("proxy : session collante"); fi
  verdict 6.1 "$n conteneurs applicatifs en lecture seule, aucune session collante au proxy" "${e[@]}"
}

c_6_2() {
  local e=() s c d vols
  vols="$(jq -r '.services | to_entries[] | select(.key == "web" or .key == "worker" or .key == "scheduler")
           | .key as $k | (.value.volumes // [])[] | "\($k):\(.target)"' <<<"$CFG_PROD" | tr '\n' ' ')"
  [[ -z "$vols" ]] || e+=("volumes sur les processus de la prod : $vols")
  for s in "${APP_SERVICES[@]}"; do
    for c in $(conteneurs "$ENV" "$s"); do
      d="$(docker diff "$c" 2>/dev/null | head -n 3 | tr '\n' ' ' || true)"
      [[ -z "$d" ]] || e+=("$s a écrit dans son conteneur : $d")
    done
  done
  verdict 6.2 "aucun volume sur les processus en prod, rien d'écrit dans les conteneurs : l'état vit dans db et cache" "${e[@]}"
}

# --- Expression : 7 Port binding, 11 Logs -----------------------------------------
c_7_1() {
  local e=() c h n=0
  for c in $(conteneurs "$ENV" web); do
    n=$((n + 1))
    h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans sonde{{end}}' "$c")"
    [[ "$h" == healthy ]] || e+=("web ${c:0:12} : $h")
  done
  (( n > 0 )) || e+=("aucun conteneur web en service")
  verdict 7.1 "$n processus web servent eux-mêmes leur port (sonde interne saine)" "${e[@]}"
}

c_7_2() {
  local e=() p ouverts
  p="$(jq -r '.services.web.environment.PORT // empty' <<<"$CFG")"
  [[ -n "$p" ]] || e+=("PORT absent de l'environnement de web")
  if [[ -n "$p" ]] && ! grep -q "web:$p" proxy/default.conf; then e+=("proxy/default.conf ne vise pas web:$p"); fi
  if jq -e '(.services.web.ports // []) | length > 0' <<<"$CFG" >/dev/null; then e+=("web publie un port sur l'hôte"); fi
  ouverts="$(jq -r '[.services | to_entries[] | .key as $k | (.value.ports // [])[]
             | select((.host_ip // "") != "127.0.0.1") | "\($k):\(.published)"] | join(" ")' <<<"$CFG")"
  [[ -z "$ouverts" ]] || e+=("ports publiés hors 127.0.0.1 : $ouverts")
  verdict 7.2 "port d'écoute lu dans la config (PORT=$p) ; seuls des ports sur 127.0.0.1 sont publiés" "${e[@]}"
}

c_11_1() {
  local e=() s n
  for s in web worker; do
    [[ -n "$(conteneurs "$ENV" "$s")" ]] || continue
    n="$(compose "$ENV" logs --no-log-prefix --no-color --since 24h "$s" 2>/dev/null | wc -l || true)"
    (( n > 0 )) || e+=("$s : aucun journal sur stdout/stderr depuis 24 h")
  done
  verdict 11.1 "journaux sur stdout/stderr, recueillis par Docker ; racine en lecture seule, aucun fichier de log possible" "${e[@]}"
}

c_11_2() {
  local e=() s lignes total brut sans_ts vus=0
  for s in web worker; do
    lignes="$(compose "$ENV" logs --no-log-prefix --no-color --tail 200 "$s" 2>/dev/null || true)"
    [[ -n "$lignes" ]] || continue
    vus=$((vus + 1))
    total="$(compter <<<"$lignes")"
    brut="$(jq -R 'fromjson? // "brut" | if type == "object" then empty else 1 end' <<<"$lignes" | compter)"
    sans_ts="$(jq -R 'fromjson? | objects | select([has("ts", "timestamp", "@timestamp", "time")] | any | not) | 1' <<<"$lignes" | compter)"
    (( brut == 0 )) || e+=("$s : $brut ligne(s) sur $total hors JSON")
    (( sans_ts == 0 )) || e+=("$s : $sans_ts événements sans horodatage")
  done
  if (( vus == 0 )); then res 11.2 manuel "aucun journal à examiner : lancer l'environnement $ENV"; return; fi
  verdict 11.2 "flux d'événements JSON horodatés, un par ligne (200 dernières lignes de web et worker)" "${e[@]}"
}

# --- Évolutif : 8 Concurrence, 9 Jetabilité ----------------------------------------
c_8_1() {
  local e=() n ok200 r=ok
  if jq -e '.services.web.container_name // empty' <<<"$CFG" >/dev/null; then e+=("web porte un container_name"); fi
  if jq -e '(.services.web.ports // []) | length > 0' <<<"$CFG" >/dev/null; then e+=("web publie un port : conflit dès deux répliques"); fi
  n="$(conteneurs "$ENV" web | compter)"
  if ! $EXERCICE; then
    verdict 8.1 "$n réplique(s) web derrière le proxy, aucun obstacle à en ajouter (épreuve : --exercice)" "${e[@]}"
    return
  fi
  echelle $((n + 1)) || e+=("échec du passage à $((n + 1)) répliques")
  [[ "$(conteneurs "$ENV" web | compter)" == "$((n + 1))" ]] || e+=("$((n + 1)) répliques attendues")
  ok200="$(for _ in $(seq 1 20); do via_proxy; echo; done | grep -c '^200$' || true)"
  (( ok200 == 20 )) || e+=("$((20 - ok200)) requêtes sur 20 en échec via le proxy")
  echelle "$n" || e+=("échec du retour à $n réplique(s)")
  (( ${#e[@]} == 0 )) || r=echec
  memoire_evenement "$ENV" "$(jq -nc --arg r "$r" '{type: "epreuve", critere: "8.1", resultat: $r}')"
  verdict 8.1 "épreuve : $((n + 1)) répliques saines, 20 requêtes sur 20 servies, retour à $n" "${e[@]}"
}

c_8_2() {
  local desc distincts
  desc="$(jq -r '.services as $s | [$s | to_entries[] | select(.value.image == $s.web.image)
          | "\(.key)=\((.value.command // []) | join(" "))"] | join(", ")' <<<"$CFG")"
  distincts="$(jq -r '.services as $s | [$s[] | select(.image == $s.web.image) | (.command // []) | join(" ")] | unique | length' <<<"$CFG")"
  if (( distincts >= 2 )); then res 8.2 ok "une image, $distincts types de processus : $desc"
  else res 8.2 ecart "un seul type de processus pour l'image de l'application : $desc"; fi
}

# Épreuve partagée par 9.1 et 9.2 : arrêter une réplique web pendant que le proxy sert,
# mesurer l'arrêt et son code, puis la redémarrer et mesurer le retour à l'état sain.
epreuve_9() {
  local f="$TMPD/epreuve9.json"
  if [[ -s "$f" ]]; then cat "$f"; return; fi
  local n0 c t0 echecs=0 code arret_ms demarrage_ms
  n0="$(conteneurs "$ENV" web | compter)"
  (( n0 >= 2 )) || echelle 2 || true          # garder le service pendant l'arrêt
  c="$(conteneurs "$ENV" web | head -n 1 || true)"
  [[ -n "$c" ]] || return 1
  t0=$(date +%s%N)
  ( docker stop -t "$(seuil arret_s)" "$c" >/dev/null; date +%s%N >"$TMPD/fin_arret" ) &
  for _ in $(seq 1 20); do
    [[ "$(via_proxy)" == 200 ]] || echecs=$((echecs + 1))
    sleep 0.1
  done
  wait
  arret_ms=$(( ($(cat "$TMPD/fin_arret") - t0) / 1000000 ))
  code="$(docker inspect -f '{{.State.ExitCode}}' "$c")"
  docker start "$c" >/dev/null
  t0=$(date +%s%N)
  until docker exec "$c" /app/bin/run health >/dev/null 2>&1; do
    (( ($(date +%s%N) - t0) < 120000000000 )) || break
    sleep 0.2
  done
  demarrage_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  (( n0 >= 2 )) || echelle "$n0" || true
  jq -nc --argjson a "$arret_ms" --argjson c "$code" --argjson e "$echecs" --argjson d "$demarrage_ms" \
    '{arret_ms: $a, code: $c, echecs: $e, demarrage_ms: $d}' | tee "$f"
  memoire_evenement "$ENV" "$(jq -c '{type: "epreuve", critere: "9.1-9.2"} + .' "$f")"
}

c_9_1() {
  if ! $EXERCICE; then res 9.1 manuel "mesure par épreuve : relancer avec --exercice"; return; fi
  local m d s
  m="$(epreuve_9)"; d="$(jq -r '.demarrage_ms' <<<"$m")"; s="$(seuil demarrage_s)"
  if [[ -z "$s" ]]; then res 9.1 calibrage "démarrage jusqu'à l'état sain : $d ms"
  elif (( d <= s * 1000 )); then res 9.1 ok "épreuve : démarrage jusqu'à l'état sain en $d ms (seuil $s s)"
  else res 9.1 ecart "épreuve : démarrage en $d ms, au-delà du seuil de $s s"; fi
}

c_9_2() {
  if ! $EXERCICE; then res 9.2 manuel "mesure par épreuve : relancer avec --exercice"; return; fi
  local m code echecs arret
  m="$(epreuve_9)"
  code="$(jq -r '.code' <<<"$m")"; echecs="$(jq -r '.echecs' <<<"$m")"; arret="$(jq -r '.arret_ms' <<<"$m")"
  case "$code" in
    0)
      if (( echecs == 0 )); then res 9.2 ok "épreuve : arrêt propre sur SIGTERM en $arret ms (code 0), aucune requête perdue"
      else res 9.2 ecart "arrêt propre (code 0) mais $echecs requêtes sur 20 perdues pendant l'arrêt"; fi ;;
    143) res 9.2 ecart "tué par SIGTERM sans le traiter (code 143) : le processus ne termine pas son travail en cours" ;;
    137) res 9.2 ecart "tué par SIGKILL au bout de $arret ms : l'arrêt dépasse le délai de grâce" ;;
    *)   res 9.2 ecart "code de sortie inattendu à l'arrêt : $code" ;;
  esac
}

c_9_3() {
  res 9.3 manuel "épreuve : enfiler N tâches idempotentes, docker kill -s KILL sur le worker en plein traitement, scripts/compose.sh $ENV up -d worker, compter exactement N résultats ; prérequis : acquittement tardif (Celery task_acks_late et task_reject_on_worker_lost, Laravel retry_after)"
}

# --- Environnement : 10 Parité dev/prod ---------------------------------------------
c_10_1() {
  local e=() s a b vus=0
  for s in $(jq -r '.services | to_entries[] | select(.value.build == null and (.key | IN("web", "worker", "scheduler") | not)) | .key' <<<"$CFG_PROD"); do
    a="$(image_id dev "$s")"; b="$(image_id prod "$s")"
    [[ -n "$a" && -n "$b" ]] || continue
    vus=$((vus + 1))
    [[ "$a" == "$b" ]] || e+=("$s : images différentes en dev et en prod")
  done
  if (( vus == 0 )); then res 10.1 manuel "lancer dev et prod pour comparer les images des services attachés"; return; fi
  verdict 10.1 "$vus services attachés : mêmes images, octet pour octet, en dev et en prod" "${e[@]}"
}

c_10_2() {
  if [[ -z "$TAG_PROD" ]]; then res 10.2 manuel "aucune release en service"; return; fi
  local ts tc td min s
  ts="$(evenements prod | jq -rs --arg c "$TAG_PROD" '[.[] | select(.type == "deploiement" and .resultat == "ok" and .commit == $c)] | (first // {}) | .ts // empty')"
  if [[ -z "$ts" ]]; then res 10.2 manuel "déploiement de $TAG_PROD absent de la mémoire"; return; fi
  tc="$(git show -s --format=%ct "$TAG_PROD")"; td="$(date -d "$ts" +%s)"
  min=$(( (td - tc) / 60 )); s="$(seuil delai_commit_prod_h)"
  if [[ -z "$s" ]]; then res 10.2 calibrage "du commit à la prod locale : $min min"
  elif (( min <= s * 60 )); then res 10.2 ok "du commit à la prod locale : $min min (seuil $s h)"
  else res 10.2 ecart "du commit à la prod locale : $min min, au-delà de $s h"; fi
}

c_10_3() {
  local par
  par="$(evenements prod | jq -rs '[.[] | select(.type == "deploiement")] | (last // {}) | .par // empty')"
  if [[ -z "$par" ]]; then res 10.3 manuel "aucun déploiement tracé dans la mémoire"; return; fi
  if git log -50 --format=%ae | grep -qxF "$par"; then res 10.3 ok "le dernier déploiement est lancé par un auteur du code ($par)"
  else res 10.3 ecart "dernier déploiement par $par, absent des 50 derniers commits"; fi
}

# --- Second ordre : Examiner, Évoluer, Équilibrer, invariant, fractale ------------------
c_EX_1() {
  local r n
  r="$(curl -fsS -m 5 -G "$LOKI_URL/loki/api/v1/query_range" --data-urlencode "query={projet=\"$(projet "$ENV")\"}" \
       --data-urlencode limit=1 --data-urlencode since=1h 2>/dev/null || true)"
  if [[ -z "$r" ]]; then res EX.1 ecart "Loki injoignable à $LOKI_URL : lancer le projet observabilite"; return; fi
  n="$(jq -r '.data.result | length' <<<"$r")"
  if (( n > 0 )); then res EX.1 ok "journaux de $(projet "$ENV") collectés par Alloy dans Loki, consultables dans Grafana"
  else res EX.1 ecart "Loki ne reçoit aucun journal de $(projet "$ENV") depuis 1 h"; fi
}

c_EX_2() {
  local nuls dernier
  if ! git ls-files --error-unmatch 7e/seuils.json >/dev/null 2>&1; then res EX.2 ecart "7e/seuils.json non versionné"; return; fi
  nuls="$(jq -r '[.seuils | to_entries[] | select(.value.critere == "EX.2" and .value.valeur == null) | .key] | join(", ")' 7e/seuils.json)"
  dernier="$(dernier_cycle "$ENV")"
  if [[ -n "$nuls" ]]; then res EX.2 calibrage "seuils en calibrage : $nuls ; chaque cycle mesure et enregistre sans verdict"
  elif [[ -z "$dernier" ]]; then res EX.2 ecart "seuils fixés, mais aucun cycle ne les a encore évalués"
  else res EX.2 ok "indicateurs évalués face aux seuils versionnés à chaque cycle (dernier : ${dernier##*/})"; fi
}

c_EV_1() {
  local n dernier age s
  if ! memoire_pret; then res EV.1 ecart "mémoire absente : scripts/7e-init.sh"; return; fi
  n="$( { find "$MEMOIRE/$ENV/cycles" -name '*.json' 2>/dev/null || true; } | compter)"
  if (( n < 2 )); then res EV.1 ecart "$n cycle(s) en mémoire : il en faut deux pour comparer"; return; fi
  dernier="$(dernier_cycle "$ENV")"
  age=$(( ($(date +%s) - $(date -d "$(jq -r '.ts' "$dernier")" +%s)) / 86400 ))
  s="$(seuil memoire_max_jours)"
  if [[ -n "$s" ]] && (( age > s )); then res EV.1 ecart "dernier cycle il y a $age jours (seuil $s)"
  else res EV.1 ok "$n cycles horodatés dans la branche cycles, dernier il y a $age jour(s)"; fi
}

c_EV_2() {
  local dernier
  dernier="$(dernier_cycle "$ENV")"
  if [[ -z "$dernier" ]]; then res EV.2 ecart "aucun cycle en mémoire"; return; fi
  if jq -e '(.commit | length > 0) and has("commit_precedent") and has("attribution")' "$dernier" >/dev/null; then
    res EV.2 ok "chaque cycle porte son commit et celui du précédent : une régression se rattache à l'intervalle précédent..courant"
  else
    res EV.2 ecart "le dernier cycle ne permet pas l'attribution (commit ou commit_precedent absent)"
  fi
}

c_EQ_1() {
  local e=() quand
  jq -e '.regles | length > 0' 7e/regles.json >/dev/null 2>&1 || e+=("7e/regles.json absent ou vide")
  quand="$(evenements prod | jq -rs '[.[] | select((.type == "epreuve" and .critere == "5.3" and .resultat == "ok") or .type == "retour_arriere")] | (last // {}) | .ts // empty')"
  [[ -n "$quand" ]] || e+=("retour arrière jamais éprouvé : scripts/7e-check.sh prod --exercice 5.3")
  verdict EQ.1 "règles versionnées (7e/regles.json) appliquées par deploy.sh et 7e-cycle.sh ; retour arrière éprouvé le $quand" "${e[@]}"
}

c_EQ_2() {
  local t age s
  t="$(git log -1 --format=%ct -- 7e/seuils.json 7e/regles.json 2>/dev/null || true)"
  if [[ -z "$t" ]]; then res EQ.2 ecart "seuils et règles jamais versionnés"; return; fi
  age=$(( ($(date +%s) - t) / 86400 )); s="$(seuil revue_max_jours)"
  if [[ -n "$s" ]] && (( age > s )); then res EQ.2 ecart "dernière revue des seuils et des règles il y a $age jours (seuil $s)"
  else res EQ.2 ok "seuils et règles revus il y a $age jour(s) ; journal : git log -- 7e/"; fi
}

c_IN_1() {
  local e=() chemins motifs p
  if ! git ls-files --error-unmatch 7e/invariant.json >/dev/null 2>&1; then res IN.1 ecart "7e/invariant.json non versionné"; return; fi
  chemins="$(jq -r '.elements[].chemin' 7e/invariant.json)"
  for p in $chemins; do [[ -e "$p" ]] || e+=("$p absent du dépôt"); done
  if [[ -z "${GITEA_URL:-}" || -z "${GITEA_REPO:-}" || -z "${GITEA_TOKEN:-}" ]]; then
    res IN.1 manuel "invariant listé ($(jq -r '[.elements[].chemin] | join(", ")' 7e/invariant.json)) ; fixer GITEA_URL, GITEA_REPO et GITEA_TOKEN pour vérifier sa protection dans Gitea"
    return
  fi
  motifs="$(curl -fsS -m 5 -H "Authorization: token $GITEA_TOKEN" "$GITEA_URL/api/v1/repos/$GITEA_REPO/branch_protections" 2>/dev/null \
    | jq -r '[.[] | select((.rule_name // .branch_name) == "main")] | (first // {}) | .protected_file_patterns // empty' 2>/dev/null || true)"
  [[ -n "$motifs" ]] || e+=("aucun motif de fichier protégé sur main dans Gitea")
  for p in $chemins; do
    if [[ -n "$motifs" && "$motifs" != *"$p"* ]]; then e+=("$p non protégé dans Gitea"); fi
  done
  verdict IN.1 "invariant listé et protégé sur main (motifs : $motifs) : la boucle ne peut pas le modifier" "${e[@]}"
}

c_FR_1() {
  local c alias
  if [[ -n "${CONSOMMATEUR:-}" && -f "$CONSOMMATEUR/compose.yaml" ]]; then
    if docker compose -f "$CONSOMMATEUR/compose.yaml" run --rm -T smoke >/dev/null 2>&1; then
      res FR.1 ok "le consommateur ($CONSOMMATEUR) atteint le service exposé par sa seule URL de config"
    else
      res FR.1 ecart "le consommateur ($CONSOMMATEUR) n'atteint pas le service exposé"
    fi
    return
  fi
  c="$(conteneurs prod proxy | head -n 1 || true)"
  alias=""
  [[ -z "$c" ]] || alias="$(docker inspect -f '{{with index .NetworkSettings.Networks "contrats"}}{{join .Aliases " "}}{{end}}' "$c" 2>/dev/null || true)"
  if [[ -n "$alias" ]]; then res FR.1 manuel "service exposé sur le réseau contrats ($alias) ; épreuve : CONSOMMATEUR=<chemin du projet consommateur>"
  else res FR.1 ecart "le proxy de la prod locale n'est pas exposé sur le réseau contrats"; fi
}

# --- exécution ---------------------------------------------------------------------
ecart=0
for id in "${IDS[@]}"; do
  f="c_${id//./_}"
  if ! declare -F "$f" >/dev/null; then res "$id" erreur "critère inconnu"; continue; fi
  # Chaque vérification tourne dans un sous-shell qui s'arrête à la première erreur ;
  # son échec n'interrompt pas les autres.
  set +e
  sortie="$(set -e; "$f")"
  rc=$?
  set -e
  if (( rc != 0 )) || [[ -z "$sortie" ]]; then
    sortie="$(res "$id" erreur "vérification interrompue : relancer scripts/7e-check.sh $ENV $id")"
  fi
  printf '%s\n' "$sortie"
  [[ "$(jq -r '.statut' <<<"$sortie")" != ecart ]] || ecart=1
done
exit "$ecart"
