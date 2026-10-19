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

## Beperkte toegang en tijdelijke ondersteuning

`access_policy_json` is optioneel voor bestaande installaties. Een expliciete policy begrenst de gedeelde entiteiten en toegestane opdrachten. Nieuwe klanten krijgen een beoordeelde policy met concrete entiteiten en services. Een lijst met alleen servicenamen is daarvoor onvoldoende. Zonder runtimepermissions kan SmartAF via deze agent geen apparaten bedienen.

`support_consent_json` is optioneel en standaard leeg. Leeg, uitgeschakeld of ongeldig betekent dat tijdelijke ondersteuning uit staat. Bestaande telemetry blijft daarbij werken. Ingeschakelde ondersteuning vereist ook een lokale access-policy die de operator, leesacties en entiteiten toestaat, plus een afzonderlijke incidentidentiteit op de server. De bestaande fleetleessleutel verleent geen incidentrechten.

Het configuratieobject bevat `enabled`, eventueel `port` (standaard 8099), `allowed_origins` met de exacte HTTPS-oorsprong van jouw Home Assistant en `allowed_user_ids` met de lokale HA-gebruikers die mogen goedkeuren. Deze gebruikerslijst blijft lokaal; zij is geen centraal bewonersprofiel. Gebruik poort 8099 bij de vaste Ingress-instelling van deze app. Open geen hostpoort.

Open de app via Home Assistant. Daar toont een supportaanvraag de woning, operator, incident, exacte leesacties, maximaal tien entiteiten en eindtijd. Controleer de aanvraag en keur hem alleen voor dat incident goed. Goedkeuring wijzigt geen apparaatinstellingen en verleent geen terminal-, Supervisor- of algemene HA-toegang. De maximale duur is dertig minuten. Via intrekken sluit je de lokale supportsessie en vervallen ook de andere supportgrants in die sessie.

Beschikbare leesacties zijn verbindingsstatus, beschikbaarheid van gekozen entiteiten, recente gestructureerde agent-commandresultaten en recente gestructureerde incidentregels. Dit is geen export van de volledige HA-loghistorie. Bij een lege commandhistorie is er geen bewijs over oudere acties van andere automations. Herstart, verbindingsverlies, verlopen toestemming of gewijzigde lokale policy vereisen nieuwe toestemming; oude goedkeuringen worden niet uit een back-up hersteld.

De app accepteert deze bediening uitsluitend via de echte Supervisor-Ingressverbinding en een toegestane lokale gebruiker. Een ontbrekende gebruikersidentiteit wordt geweigerd. Zie de [officiële Ingress-uitleg](https://contributors.home-assistant.io/apps/guides/ingress/). Een aparte oudere beheerverbinding naar HA valt buiten deze app-policy en moet afzonderlijk worden afgebouwd.

Gewone wachtrijen voor automationtelemetrie en een gevraagde nieuwe snapshot beëindigen een geldige supporttoestemming niet. De echte wachtrijlengte blijft zichtbaar in de verbindingsdiagnose. Een echte HA- of serververbindingsbreuk, een ander serverproces, verlopen toestemming of lokale intrekking beëindigt de toegang wel. De begrensde supportlog kan een korte onderbreking later als overgang melden; die logregel is geen actuele verbindingsmeting.

## Optionele zonnegegevens

De bestaande optionele access-policy kan `telemetry.solar_history` bevatten met `timezone`, `source_entities.sunrise`, `source_entities.sunset` en een gezamenlijke `configuration_epoch`. Zonder dit onderdeel blijft het bestaande gedrag behouden. SmartAF moet de twee bestaande Sun-timestampsensoren en hun geschiedenis eerst controleren. De app schakelt geen entiteiten in en vraagt geen extra Supervisorrechten.

De app leest uitsluitend de begrensde geschiedenis van deze twee geselecteerde bronnen. Naar de server gaat één gevalideerd feit voor de huidige lokale dag, gekoppeld aan woning, tijdzone, bronnen, configuratieversie en verbinding. Er gaan geen locatie of ruwe geschiedenis mee. Bij ontbrekende, dubbelzinnige of ongeldige gegevens volgt geen oud reservefeit en geen schatting van de vorige dag. Alle automationbeslissingen blijven centraal.

De configuratieversie is een beheerd label en bewijst op zichzelf geen ongewijzigde historische HA-locatie, hoogte of tijdzone. Deze integratie is voorbereid voor centrale schaduwevaluatie en verleent geen apparaatbediening. Bij een relevante configuratiewijziging moet SmartAF de bronnen opnieuw beoordelen, het onderdeel tijdelijk uitschakelen en beide configuratieversies opnieuw afstemmen. Installeer eerst een geschikte agentversie en pas daarna de optionele policy toe. Verwijder bij teruggaan naar een oudere versie eerst dit nieuwe policyonderdeel.
