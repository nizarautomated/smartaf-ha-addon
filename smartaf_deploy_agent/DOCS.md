# SmartAF Node-RED Deploy Agent

Deze Home Assistant-app controleert de private repository
`nizarautomated/home-assistant-node-red` op `deployments/pending.json`.

Een deployment wordt alleen toegepast wanneer:

- de canonieke SHA-256-hash van de live `flows.json` exact overeenkomt;
- alle node-ID's uniek zijn;
- alle bedrading naar bestaande nodes verwijst;
- de verwachte node-types en namen overeenkomen;
- serverconfiguraties niet onverwacht wijzigen;
- bedradingswijzigingen expliciet zijn toegestaan.

Voor iedere wijziging wordt een lokale back-up gemaakt. Na toepassing wordt
Node-RED via de Supervisor-API herstart. Wanneer de herstart of nacontrole
mislukt, wordt automatisch teruggerold.

## Configuratie

Maak een fine-grained GitHub-token voor uitsluitend:

- repository: `nizarautomated/home-assistant-node-red`;
- permission: **Contents — Read and write**.

Het token is nodig om deployments te lezen en het resultaat terug te schrijven
naar `deployments/status/<deployment_id>.json`. De agent vergelijkt daarnaast
de gevalideerde live graph met `current/flows.json`. Alleen wanneer de canonieke
hash afwijkt, schrijft hij de live graph terug naar deze repositorybaseline.
Een tijdelijke GitHub-fout blokkeert Node-RED niet: de synchronisatie wordt bij
de volgende poll opnieuw geprobeerd.

Vul het token in bij `github_token`. Laat de overige waarden ongewijzigd,
tenzij het Node-RED app-ID of het pad naar `flows.json` op jouw installatie
anders is.

## Read-only diagnostiek

De bestaande entity-diagnostiek bewaakt uitsluitend expliciet aangevraagde
entiteiten, maximaal 10 tegelijk en maximaal 120 seconden. Een request kan nu
optioneel maximaal 10 expliciete `automation.*`-entiteiten bevatten. De agent
resolveert hun interne trace-ID en leest maximaal vijf recente traces per
automation via Home Assistant `trace/list` en `trace/get`.

Rapporten bevatten begin- en eindstatus, state-overgangen, contextcorrelatie,
milliseconde-timing en maximaal 500 gesaniteerde trace-stappen. Attributes,
traceconfiguratie, tracevariabelen en credentials worden niet gepubliceerd.
De diagnostiek doet geen servicecalls en schrijft geen Home Assistant-state.
Wanneer de trace-API niet beschikbaar is, blijft het state-deel van het rapport
bruikbaar en wordt de tracecollectie afzonderlijk als mislukt gemarkeerd.

## Centrale healthstatus

De aparte maintenance-runner controleert Home Assistant Core, Supervisor,
Node-RED, de live flowgraph, de repositorybaseline, de SmartAF-integratie en de
Deploy Agent zelf. De actuele, credentialvrije status wordt lokaal opgeslagen
in `/data/health.json` en centraal gepubliceerd naar `health/current.json`.
Statuswijzigingen worden direct bij de volgende controle gepubliceerd; een
ongewijzigde status krijgt standaard iedere zes uur een heartbeat.

De healthchecks zijn read-only. Ze schrijven niet naar Home Assistant,
Node-RED of de flowgraph en voeren geen patroonherkenning uit.

Bij een volledig servergestuurde woning kan `server_only_mode` optioneel worden
ingeschakeld en wordt `local_agent_slug` ingesteld. Health vereist dan juist
dat lokale Node-RED gestopt is en de transport-only Local Agent gestart is.
Zonder deze instelling blijft het bestaande healthcontract ongewijzigd.

## Rapportretentie

Historische deployment-, voorstel-, diagnose-, logdiagnose- en
commandorapporten kunnen begrensd worden met de optionele instelling
`report_retention_enabled`. Deze staat intern standaard uit. Na inschakeling
wordt een rapport alleen verwijderd wanneer het zowel ouder is dan
`report_retention_days` (standaard 90 dagen) als buiten de nieuwste
`report_retention_count` rapporten (standaard 100) valt.

Per onderhoudsrun worden maximaal 500 rapporten per map bekeken en maximaal
100 rapporten in één atomische GitHub-commit verwijderd. Rapporten zonder
betrouwbare tijdstempel blijven altijd bewaard. Verzoekbestanden, audits,
`current/flows.json`, healthstatus, lokale status en back-ups vallen buiten
retentie.

Alle maintenance-instellingen zijn optioneel en hebben veilige interne
standaardwaarden:

- `health_report_path`;
- `health_publish_interval_seconds`;
- `report_retention_enabled`;
- `report_retention_days`;
- `report_retention_count`;
- `report_retention_check_interval_seconds`.

## Rechten

De app krijgt:

- schrijfbare toegang tot `/addon_configs`;
- schrijfbare toegang tot `/homeassistant/custom_components/smartaf`;
- toegang tot de Supervisor-API met de rol `manager`;
- een eigen, schrijfbare `/data`-map voor back-ups en status.

Voor Node-RED leest of wijzigt de code uitsluitend het ingestelde `flows_path`.
Binnen de Home Assistant-configuratiemap synchroniseert de app uitsluitend de
vaste allowlist onder `custom_components/smartaf`; `configuration.yaml` en
`.storage` worden niet gewijzigd. Door de mapmachtigingen kan het proces
technisch andere configuratiebestanden bereiken; daarom moet de publieke
broncode en iedere wijziging eraan worden gecontroleerd.

## Lokale gegevens

- back-ups: `/data/backups`;
- resultaten: `/data/results`;
- laatst verwerkte deployment: `/data/state.json`.
