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
