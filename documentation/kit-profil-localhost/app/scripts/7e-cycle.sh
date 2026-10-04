#!/usr/bin/env bash
# Un cycle 7E sur un environnement : les sept phases, de l'état observé à la correction.
# usage : scripts/7e-cycle.sh dev|prod [--exercice]
# Quand : après chaque déploiement, au moins une fois par jour, chaque semaine avec --exercice.
# Code de sortie : 1 si un critère est en écart ou un indicateur hors seuil, 0 sinon.
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need docker git jq curl

env="${1:-}"
env_valide "$env"
shift
exercice=()
if [[ "${1:-}" == --exercice ]]; then exercice=(--exercice); fi
cd "$RACINE"
memoire_pret || die "mémoire absente : lancer scripts/7e-init.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# 1. Évaluer : l'état du système et le cycle précédent ------------------------------
if [[ "$env" == prod ]]; then
  commit="$(etat_lire prod.tag || true)"
  [[ -n "$commit" ]] || die "aucune release en service : scripts/deploy.sh <commit>"
else
  commit="$(git rev-parse HEAD)"
fi
precedent="$(dernier_cycle "$env")"
commit_prec=""
if [[ -n "$precedent" ]]; then commit_prec="$(jq -r '.commit' "$precedent")"; fi

# 2. Élaborer : seuils et règles versionnés, fenêtre d'observation ------------------
fenetre="$(seuil fenetre_min)"
fenetre="${fenetre:-15}"
s5xx="$(seuil taux_5xx)"
sp95="$(seuil latence_p95_ms)"
modifies=false
if ! git diff --quiet HEAD -- 7e/; then
  modifies=true
  info "seuils ou règles modifiés hors commit : ce cycle ne sera pas rattaché à une version (EQ.2)"
fi
versions="$(jq -nc --arg s "$(git log -1 --format=%h -- 7e/seuils.json)" \
  --arg r "$(git log -1 --format=%h -- 7e/regles.json)" --argjson m "$modifies" \
  '{seuils: $s, regles: $r, modifies_hors_commit: $m}')"

# 3. Exécuter : vérifier les 35 critères, épreuves comprises avec --exercice --------
info "cycle $env ${commit:0:12} : vérification des critères"
"$RACINE/scripts/7e-check.sh" "$env" "${exercice[@]}" >"$T/criteres.jsonl" || true

# 4. Examiner : indicateurs mesurés sur la fenêtre, face aux seuils (EX.2) ------------
compose "$env" logs --no-log-prefix --no-color --since "${fenetre}m" proxy 2>/dev/null \
  | jq -R -c 'fromjson? | objects | select(has("status"))' >"$T/acces.jsonl" || true
indicateurs="$(jq -s --argjson s5 "${s5xx:-null}" --argjson sp "${sp95:-null}" --argjson f "$fenetre" '
  def verdict($m; $s):
    if $s == null then "calibrage" elif $m == null then "sans_trafic" elif $m <= $s then "ok" else "hors_seuil" end;
  length as $n
  | (map(select(.status >= 500)) | length) as $e
  | (map(.rt) | sort) as $rt
  | (if $n > 0 then $e / $n else null end) as $taux
  | (if $n > 0 then ($rt[(($n * 95 + 99) / 100 | floor) - 1] * 1000 | round) else null end) as $p95
  | {fenetre_min: $f, requetes: $n,
     taux_5xx:       {mesure: $taux, seuil: $s5, verdict: verdict($taux; $s5)},
     latence_p95_ms: {mesure: $p95,  seuil: $sp, verdict: verdict($p95; $sp)}}' "$T/acces.jsonl")"

# 5. Évoluer : comparer au cycle précédent, rattacher les régressions aux commits (EV.2)
nouvelle_release=false
if [[ -n "$commit_prec" && "$commit" != "$commit_prec" ]]; then nouvelle_release=true; fi
: >"$T/prec.jsonl"
ind_prec=null
if [[ -n "$precedent" ]]; then
  jq -c '.criteres[]' "$precedent" >"$T/prec.jsonl"
  ind_prec="$(jq -c '.indicateurs' "$precedent")"
fi
regressions="$(jq -nc --slurpfile cur "$T/criteres.jsonl" --slurpfile prev "$T/prec.jsonl" '
  ($prev | map({key: .id, value: .statut}) | from_entries) as $p
  | [$cur[] | select(.statut == "ecart" and ($p[.id] // "") == "ok") | .id]')"
degrades="$(jq -nc --argjson a "$ind_prec" --argjson b "$indicateurs" '
  [("taux_5xx", "latence_p95_ms") as $k
   | select($b[$k].verdict == "hors_seuil" and ((($a // {})[$k] // {}).verdict // "") != "hors_seuil") | $k]')"
attribution='[]'
if $nouvelle_release; then
  attribution="$(git log -n 20 --format='%h %s' "$commit_prec..$commit" 2>/dev/null | jq -R . | jq -sc . || echo '[]')"
fi

# 6. Émettre : enregistrer le cycle dans la mémoire, publier le résumé ----------------
fichier="$MEMOIRE/$env/cycles/$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}.json"
mkdir -p "${fichier%/*}"
jq -n --arg ts "$(horodatage)" --arg env "$env" --arg c "$commit" --arg p "$commit_prec" \
  --argjson nouvelle "$nouvelle_release" --argjson versions "$versions" --argjson ind "$indicateurs" \
  --slurpfile crit "$T/criteres.jsonl" --argjson reg "$regressions" --argjson deg "$degrades" \
  --argjson attr "$attribution" '
  {version: 1, ts: $ts, env: $env, commit: $c, commit_precedent: (if $p == "" then null else $p end),
   nouvelle_release: $nouvelle, versions: $versions, indicateurs: $ind,
   bilan: ($crit | group_by(.statut) | map({key: .[0].statut, value: length}) | from_entries),
   criteres: $crit, regressions: $reg, indicateurs_degrades: $deg, attribution: $attr}' >"$fichier"
memoire_valider "cycle $env ${commit:0:12}"

jq -r '"7e: cycle \(.env) \(.commit[0:12]) : "
  + (.bilan | to_entries | map("\(.value) \(.key)") | join(", "))
  + " ; 5xx \(.indicateurs.taux_5xx.verdict) ; p95 \(.indicateurs.latence_p95_ms.verdict)"
  + (if (.regressions | length) > 0 then " ; régressions : \(.regressions | join(" "))" else "" end)' "$fichier" >&2
jq -r '.criteres[] | select(.statut == "ecart") | "7e:   écart \(.id) : \(.preuve)"' "$fichier" >&2

# 7. Équilibrer : appliquer 7e/regles.json, la correction la plus réversible d'abord --
nb_degrades="$(jq 'length' <<<"$degrades")"
nb_hors="$(jq '[.taux_5xx, .latence_p95_ms] | map(select(.verdict == "hors_seuil")) | length' <<<"$indicateurs")"
nb_ecarts="$(jq '.bilan.ecart // 0' "$fichier")"

if (( nb_degrades > 0 )) && [[ "$env" == prod ]] && $nouvelle_release; then
  info "R2 : $(jq -r 'join(", ")' <<<"$degrades") dégradé(s) depuis la release ${commit:0:12} : retour arrière"
  if ! "$RACINE/scripts/rollback.sh"; then
    ticket "retour arrière impossible après dégradation ($env)" "Cycle : ${fichier##*/}. Indicateurs : $indicateurs"
  fi
elif (( nb_hors > 0 )); then
  ticket "indicateur hors seuil ($env)" "Règle R3. Cycle : ${fichier##*/}. Indicateurs : $indicateurs"
  memoire_evenement "$env" "$(jq -nc --arg c "${fichier##*/}" '{type: "ticket", regle: "R3", cycle: $c}')"
fi

if [[ "$(jq 'length' <<<"$regressions")" -gt 0 ]]; then
  ticket "critères passés de ok à écart ($env) : $(jq -r 'join(" ")' <<<"$regressions")" \
    "Règle R4. Cycle : ${fichier##*/}. Commits depuis le cycle précédent : $(jq -r 'join(" | ")' <<<"$attribution")"
  memoire_evenement "$env" "$(jq -nc --arg c "${fichier##*/}" --argjson r "$regressions" '{type: "ticket", regle: "R4", cycle: $c, criteres: $r}')"
fi

# R5 : un seuil en calibrage reçoit une mesure par cycle ; la revue EQ.2 le fixe
# à partir de cet historique, par un commit sur 7e/seuils.json.
jq -r 'to_entries[] | select(.value | type == "object" and .verdict == "calibrage" and .mesure != null)
       | "7e: R5 : \(.key) mesuré \(.value.mesure) : à fixer à la prochaine revue EQ.2"' <<<"$indicateurs" >&2

(( nb_ecarts == 0 && nb_hors == 0 ))
