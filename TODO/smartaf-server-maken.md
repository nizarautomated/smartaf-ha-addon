# TODO — SmartAF server maken

## Doel

Bouw een centrale SmartAF-serverarchitectuur waarbij de commerciële automationlogica en Node-RED-flows niet op de Home Assistant Green van klanten staan.

## Kernarchitectuur

- Op iedere klantlocatie draait alleen Home Assistant + een minimale SmartAF Agent.
- De SmartAF Agent maakt een versleutelde outbound verbinding met de SmartAF-server.
- HA-events worden server-side verwerkt.
- Node-RED / SmartAF Automation Engine draait uitsluitend server-side.
- De server stuurt gevalideerde acties terug naar de betreffende Home Assistant-installatie.
- Klanten krijgen geen lokale kopie van de Node-RED-flows of commerciële automationbroncode.

## Multi-tenant ontwerp

Gebruik één centrale codebase voor alle klanten.

Iedere klant/woning krijgt een eigen `home_id` / tenant-identiteit. Iedere event, state, command, logregel, configuratie en cache-entry moet expliciet aan die `home_id` gekoppeld zijn.

Nooit aparte geforkte codebases per klant gebruiken.

## Configuratie in plaats van klant-specifieke code

Verschillen tussen klanten worden opgeslagen als configuratie, bijvoorbeeld:

- ruimtes;
- HA entity mappings;
- device roles;
- feature toggles;
- tijdschema's;
- thresholds;
- lichtprofielen;
- alarmopties;
- notification targets;
- enabled SmartAF modules.

Generieke automationmodules kunnen bijvoorbeeld zijn:

- Lighting
- Presence
- Alarm
- Curtains
- Climate
- Vacuum
- Ventilation
- Notifications
- Energy

## Maatwerkautomations

Maak voor echt maatwerk een declaratieve SmartAF Rule Engine.

Een klant-specifieke automation wordt data/configuratie met:

- trigger;
- conditions;
- actions;
- timing/delay;
- enabled status;
- versie.

Maak dus niet voor iedere maatwerkvraag een nieuwe Node-RED-flow.

Nieuwe terugkerende klantwensen moeten bij voorkeur als generieke capability/module worden toegevoegd zodat andere klanten dezelfde functionaliteit kunnen gebruiken.

## SmartAF Agent op HA Green

De lokale agent bevat alleen wat lokaal noodzakelijk is:

- verbinding/authenticatie met SmartAF Cloud;
- HA events uitlezen;
- events naar server sturen;
- servercommands ontvangen;
- commands valideren en uitvoeren;
- heartbeat;
- buffering/reconnect;
- diagnostics;
- updates;
- minimale offline/safety failsafes.

Geen commerciële automationlogica lokaal opslaan.

## Security

Iedere Green krijgt een unieke identiteit en credentials/certificaat.

Minimaal:

- unieke `home_id`;
- unieke device/agent identity;
- eigen client certificate / private key of vergelijkbare sterke credentials;
- TLS, bij voorkeur mTLS;
- strikt tenant-isolation;
- commands moeten gesigneerd/geauthenticeerd en tijdgebonden zijn;
- een agent van klant A mag nooit data of commands van klant B kunnen lezen of uitvoeren.

## Centrale infrastructuur

Beoogde componenten:

1. SmartAF Gateway/API
2. authenticatie/device identity
3. event routing
4. SmartAF Automation Engine / voorlopig server-side Node-RED
5. PostgreSQL configuratiedatabase
6. event queue / message bus waar nodig
7. command delivery
8. observability/logging/metrics
9. fleet management
10. versioning en rollback van klantconfiguraties

## Onderhoudbaarheid bij 100+ klanten

Doelmodel:

`1 codebase + N klantconfiguraties + N beveiligde verbindingen`

Niet:

`N Node-RED processen + N flowcopies + N geforkte codebases`

Bugfixes in generieke automationlogica worden centraal uitgerold en gelden direct voor alle relevante klanten.

Klantconfiguraties worden afzonderlijk geversioned zodat één klantconfiguratie kan worden teruggedraaid zonder de automation-engine voor andere klanten terug te rollen.

## Templates

Gebruik standaard woningtemplates als startpunt voor onboarding, bijvoorbeeld `SmartAF Standard Home`.

Nieuwe klant = template + gevonden devices + room mappings + klantvoorkeuren + optionele custom rules.

## Migratiestrategie

1. Huidige `home-assistant-node-red` installatie blijft reference/development implementation.
2. Identificeer generieke bestaande flows.
3. Trek entity-namen en woning-specifieke waarden uit de flowlogica.
4. Vervang deze door abstracte device roles en configuratie.
5. Verplaats Node-RED server-side.
6. Laat SmartAF Agent alleen events en commands transporteren.
7. Bouw declaratieve Rule Engine voor maatwerk.
8. Migreer later Node-RED-componenten naar een eigen SmartAF Automation Engine zonder wijzigingen aan klantagents.

## Offline gedrag

Deze architectuur is bewust cloud-first. Comfortautomations mogen bij internet/serveruitval tijdelijk stoppen.

Safety-critical functies en de eerder vastgelegde alarm-offline-failsafe moeten lokaal minimaal veilig blijven functioneren.

Zie ook:

- `TODO/cloud-alarm-offline-failsafe.md`

## Testscenario's

- [ ] Event van klant A kan nooit config/state van klant B ophalen.
- [ ] Command voor klant A kan nooit door agent B worden uitgevoerd.
- [ ] 100 gelijktijdige agents blijven onafhankelijk verbonden.
- [ ] Server restart -> agents reconnecten automatisch.
- [ ] Tijdelijke netwerkuitval -> buffering/reconnect werkt voorspelbaar.
- [ ] Config wijziging klant A heeft geen effect op klant B.
- [ ] Engine bugfix werkt zonder deployment naar alle Greens.
- [ ] Config rollback kan per klant afzonderlijk.
- [ ] Custom rule kan worden toegevoegd zonder nieuwe Node-RED-flow.
- [ ] Ongeldige/geëxpireerde servercommands worden lokaal geweigerd.
- [ ] Observability toont per home_id events, beslissingen, commands, latency en fouten.

## Architectuurcontrole bij implementatie

Voor implementatie eerst conflictcontrole uitvoeren met bestaande Node-RED-, SmartAF deploy-, diagnostics-, health-, alarm-, presence- en notificationlogica. Hergebruik bestaande componenten waar mogelijk en bouw geen parallel tweede deploymentsysteem.