# TODO — Cloud alarm fail-safe bij internet-/serveruitval

## Wanneer uitvoeren

Implementeren zodra SmartAF automationlogica server-side draait en Home Assistant-installaties van klanten afhankelijk worden van de SmartAF-server voor alarmbeslissingen.

## Doel

Voorkomen dat een reeds ingeschakeld alarm een sirene of alarmactie activeert wanneer de SmartAF-cloudverbinding wegvalt en de server de sensortrigger niet meer betrouwbaar kan beoordelen.

## Gewenste architectuur

Gebruik lokaal op de Home Assistant Green alleen een minimale fail-safe/state-machine. De commerciële alarmintelligentie en Node-RED/SmartAF automationlogica blijven server-side.

Minimale toestanden:

- `DISARMED`
- `ARMED_ONLINE`
- `ARMED_OFFLINE`
- `TRIGGERED`

Overgangen:

1. Alleen automatisch inschakelen wanneer de SmartAF-server bereikbaar en gezond is.
2. Bij verlies van geldige SmartAF-heartbeats: `ARMED_ONLINE -> ARMED_OFFLINE`.
3. In `ARMED_OFFLINE` mogen deur-, raam-, bewegings- en overige inbraaksensoren geen nieuwe sirene/alarmtrigger veroorzaken.
4. Handmatig uitschakelen moet lokaal mogelijk blijven.
5. Als het alarm al `TRIGGERED` is voordat de verbinding wegvalt, mag internetuitval de actieve alarmcyclus niet automatisch stoppen; een lokale timeout/veilige afhandeling blijft actief.
6. Wanneer de SmartAF-serververbinding betrouwbaar terug is, mag `ARMED_OFFLINE -> ARMED_ONLINE` pas na healthcheck en state-synchronisatie plaatsvinden.

## Beschikbaarheidsdetectie

Niet alleen controleren of internet algemeen beschikbaar is. De lokale agent moet controleren of de daadwerkelijke SmartAF-dienst werkt, inclusief:

- netwerkverbinding;
- DNS;
- TLS;
- authenticatie;
- SmartAF backend health;
- geldige periodieke heartbeat.

Gebruik een expliciete timeout zodat een oude verbinding niet als online wordt beschouwd.

## Veiligheidsregels

- Geen nieuwe auto-arm wanneer SmartAF cloud unavailable is.
- Geen nieuwe inbraakalarmtrigger in `ARMED_OFFLINE`.
- Geen automatische disarm puur omdat internet wegvalt.
- Bestaande `TRIGGERED` toestand lokaal veilig afhandelen.
- Rook, CO, waterlek en andere safety-critical functies mogen niet afhankelijk zijn van deze cloud fail-safe en moeten waar nodig lokaal blijven functioneren.

## Observability

Log minimaal:

- timestamp laatste geldige heartbeat;
- overgang online/offline;
- huidige alarm state;
- sensortrigger die wegens offline-modus is onderdrukt;
- herstelde verbinding;
- state-resynchronisatie met server;
- reden waarom auto-arm is geweigerd.

## Testscenario's

- [ ] Alarm uit + internet valt weg -> alarm blijft uit.
- [ ] Alarm aan + internet valt weg -> `ARMED_OFFLINE`.
- [ ] Deur opent tijdens `ARMED_OFFLINE` -> geen sirene/alarmtrigger.
- [ ] Bewegingssensor triggert tijdens `ARMED_OFFLINE` -> geen sirene/alarmtrigger.
- [ ] Auto-arm request zonder geldige SmartAF-verbinding -> geweigerd.
- [ ] Alarm is al `TRIGGERED` + internet valt weg -> lokale alarmcyclus blijft correct aflopen.
- [ ] Handmatige disarm tijdens internetuitval -> blijft mogelijk.
- [ ] Internet herstelt -> eerst healthcheck/state-sync, daarna terug naar `ARMED_ONLINE`.
- [ ] Flapperende verbinding -> geen snelle ongewenste state-wisselingen/race conditions.
- [ ] SmartAF-server bereikbaar maar ongezond/authentication failed -> behandelen als offline.

## Architectuurvoorwaarden

Bij implementatie eerst conflictcontrole uitvoeren met bestaande alarm-, presence-, supervisor- en notification-logica. Houd de lokale fail-safe generiek en minimaal zodat de waardevolle SmartAF automationlogica niet op klantapparatuur hoeft te staan.
