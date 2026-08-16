# SmartAF Local Agent

Deze app vormt uitsluitend de beveiligde verbinding tussen Home Assistant en het centrale SmartAF-platform. De app bevat geen automationflows, triggers, conditions, timers of woninglogica.

## Voor installatie

SmartAF moet voor iedere woning drie waarden uitgeven:

- `home_id`;
- `agent_id`;
- een unieke `agent_token` van minimaal 32 tekens.

De `control_plane_url` moet een geldige HTTPS-ingang van SmartAF zijn. Deel de agenttoken niet via chat, GitHub of diagnostische logs.

## Gedrag

- Home Assistant blijft de lokale device- en state-API en verzorgt de radio-integraties.
- De app stuurt minimale state-events naar de server; attributen en vrije servicetekst worden niet doorgestuurd.
- Na een herverbinding vult een gemarkeerde snapshot alleen de servercache en triggert die geen automation.
- Alleen opdrachten voor de eigen woning, binnen de TTL en binnen de ingestelde serviceallowlist worden uitgevoerd.
- Events en commandresultaten worden in `/data` bewaard zodat een app-herstart geen dubbele uitvoering veroorzaakt.
- Bij serveruitval blijft handmatige bediening in Home Assistant beschikbaar, maar start geen lokale automationkopie.

## Configuratie

Wijzig de standaardidentiteit pas nadat SmartAF de productie-identiteit heeft uitgegeven. Laat de serviceallowlist zo klein mogelijk; uitbreiden is alleen nodig voor daadwerkelijk geactiveerde modules.

Na opslaan moet de app opnieuw worden gestart. Een gezonde log toont `ha_connected`, een gebufferde statesnapshot en geslaagde heartbeats zonder tokens of Home Assistant-attributen.
