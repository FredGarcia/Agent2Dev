-- ═══════════════════════════════════════════════════════════════════════════
--  004_decision_motif.sql : le motif des décisions du journal (contrat 0.3)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Depuis le modèle 0.3.0, chaque décision d'une entrée de journal porte son
--  motif (contrats.journal.champs.decisions.motif) : la mesure hors seuil et
--  son seuil, puis la correction remplacée si Équilibrer est bloquée. La vue
--  l'expose en dernière colonne. Une entrée du contrat 0.2 ne l'écrivait que
--  si Équilibrer était bloquée : ailleurs, il reste vide.
--
--  CREATE OR REPLACE VIEW garde les droits accordés à la vue (002_donnees.sql).

CREATE OR REPLACE VIEW donnees.decision AS
SELECT e.instance, e.numero, d.rang::integer AS rang, d.v ->> 'indicateur' AS indicateur, d.v ->> 'critere' AS critere,
       d.v ->> 'correction' AS correction, donnees.booleen(d.v -> 'reversible') AS reversible, d.v ->> 'cible' AS cible,
       d.v ->> 'motif' AS motif
FROM donnees.entree e, jsonb_array_elements(donnees.liste(e.contenu -> 'decisions')) WITH ORDINALITY AS d(v, rang);
