# Roadmap — SmartAF Server, Automation Engines en Rule Engine

## Doel

SmartAF evolueren van een lokale Home Assistant + Node-RED-installatie naar een beheerd multi-tenant platform waarbij:

- klantinstallaties geen Node-RED-flows of commerciële automationbroncode bevatten;
- één centrale SmartAF-codebase alle klanten bedient;
- verschillen tussen woningen als configuratie, device-mapping en declaratieve rules worden opgeslagen;
- tijdkritische automatisering met lage latency blijft werken;
- internet-/serveruitval gecontroleerd en veilig wordt afgehandeld;
- configuratie, engineversies en klantregels afzonderlijk versioned en rollbackbaar zijn;
- observability end-to-end timing en beslissingen inzichtelijk maakt.

## Architectuurdoel

```text
Home Assistant Green klant
        │
        ▼
SmartAF Local Agent
- outbound permanente verbinding
- authentication / device identity
- HA event forwarding
- command execution
- heartbeat
- buffering
- diagnostics
- minimale offline failsafes
        │
        ▼
SmartAF Cloud Gateway
        │
        ├── Customer/Tenant Router
        ├── Event Bus
        ├── In-memory config cache
        ├── Automation Engines
        │     ├── Lighting Engine
        │     ├── Presence Engine
        │     ├── Alarm Engine
        │     ├── Curtain/Cover Engine
        │     ├── Climate Engine
        │     ├── Media Engine
        │     └── Notification/Camera Engine
        │
        ├── Rule Engine
        ├── PostgreSQL
        ├── Observability
        └── Fleet/Admin API
```

---

## Fase 0 — Bestaande logica inventariseren en classificeren

### Doel
Voorkomen dat bestaande Node-RED-logica blind wordt gekopieerd naar de server.

### Werk
- [ ] Alle huidige Node-RED-flows inventariseren.
- [ ] Per flow vastleggen: trigger, conditions, acties, gebruikte entities, helpers, timers en afhankelijkheden.
- [ ] Flows groeperen in generieke domeinen: lighting, presence, alarm, covers, climate, media, vacuum, notifications, supervisor/failsafe.
- [ ] Duplicaten en woning-specifieke hardcoded entity_ids identificeren.
- [ ] Bepalen welke logica een generieke Automation Engine hoort te worden.
- [ ] Bepalen welke logica als declaratieve Rule kan worden gemodelleerd.
- [ ] Bepalen welke uitzonderingen echte nieuwe capabilities vereisen.
- [ ] Conflictcontrole uitvoeren tussen bestaande flows voordat migratie start.

### Exit criteria
- Elke bestaande flow heeft één migratiecategorie: engine, rule, config, local failsafe of verwijderen.

---

## Fase 1 — Event- en commandprotocol definiëren

### Doel
Een stabiele grens maken tussen HA Green en SmartAF Cloud zodat serverimplementaties later kunnen wisselen zonder klantmigratie.

### Werk
- [ ] Definieer uniek `home_id`, `agent_id`, `event_id`, `request_id` en `sequence`.
- [ ] Definieer event-envelope voor HA state changes en events.
- [ ] Definieer command-envelope voor service calls naar HA.
- [ ] Voeg timestamps toe op iedere hop.
- [ ] Definieer acknowledgements, timeouts en retries.
- [ ] Definieer idempotency zodat hetzelfde command niet dubbel wordt uitgevoerd.
- [ ] Definieer protocolversie en backward compatibility.
- [ ] Definieer maximaal toegestane command age/TTL.

### Voorbeeld event
```json
{
  "protocol_version": 1,
  "home_id": "home_f73a82",
  "agent_id": "agent_01",
  "event_id": "evt_123",
  "sequence": 812739,
  "occurred_at": "2026-08-12T20:31:12.482+02:00",
  "type": "state_changed",
  "payload": {
    "entity_id": "binary_sensor.motion_kitchen",
    "old_state": "off",
    "new_state": "on"
  }
}
```

---

## Fase 2 — SmartAF Local Agent uitbreiden

### Doel
De HA Green terugbrengen tot device gateway + veilige lokale agent, zonder commerciële automationlogica.

### Werk
- [ ] Permanente outbound WebSocket/mTLS-verbinding naar SmartAF Gateway.
- [ ] HA events realtime subscriben en doorsturen.
- [ ] Alleen expliciet toegestane HA-services laten uitvoeren.
- [ ] Command-validatie op `home_id`, signature/auth, TTL en protocolversie.
- [ ] Heartbeat en health reporting.
- [ ] Reconnect met jitter/backoff.
- [ ] Kleine bounded event-buffer voor tijdelijke netwerkonderbreking.
- [ ] Deduplicatie van events/commands.
- [ ] Lokale diagnostics en timingmetingen.
- [ ] Geen Node-RED-flows of centrale automationregels lokaal opslaan.

### Security
- [ ] Unieke identity per Green.
- [ ] Geen universele API-key voor alle klanten.
- [ ] Certificaat/key rotatie ondersteunen.
- [ ] Een agent van woning A mag nooit commands voor woning B accepteren.

---

## Fase 3 — SmartAF Cloud Gateway bouwen

### Doel
Een schaalbare, veilige ingang voor alle klantinstallaties.

### Werk
- [ ] Persistent connection management.
- [ ] Authenticatie van agent identity.
- [ ] Mapping agent -> home_id.
- [ ] Tenant-isolatie afdwingen vóór verdere verwerking.
- [ ] Event routing naar juiste automation workers.
- [ ] Command routing terug naar juiste agent.
- [ ] Connection state en last_seen bijhouden.
- [ ] Rate limiting per woning.
- [ ] Audit logging voor security-relevante events.

### Harde regel
Iedere event-, state-, config-, cache- en commandrecord bevat `home_id`.

---

## Fase 4 — Multi-tenant configuratiemodel + PostgreSQL

### Doel
Eén codebase laten werken voor woningen met totaal verschillende entities, ruimtes en voorkeuren.

### Tabellen / domeinen
- [ ] customers
- [ ] homes
- [ ] agents
- [ ] rooms
- [ ] devices
- [ ] device_roles
- [ ] feature_config
- [ ] custom_rules
- [ ] runtime_state
- [ ] config_revisions
- [ ] audit_log

### Device abstraction
Voorbeeld:

```text
home_001: kitchen.main_light -> light.keuken
home_002: kitchen.main_light -> light.hue_ceiling_kitchen
home_003: kitchen.main_light -> light.kitchen_group
```

Automationcode gebruikt alleen semantische roles/capabilities, niet klant-specifieke entity_ids.

### Config versioning
- [ ] Iedere wijziging krijgt revision.
- [ ] Schema-validatie vóór activering.
- [ ] Rollback per woning.
- [ ] Audit wie/wat configuratie wijzigde.

---

## Fase 5 — In-memory config/state cache

### Doel
Cloudlatency beperken voor tijdkritische automations.

### Werk
- [ ] Actieve klantconfiguratie in geheugen/cache houden.
- [ ] Device-role mappings in geheugen houden.
- [ ] Veelgebruikte runtime-state in snelle state store houden.
- [ ] Geen PostgreSQL-query in het kritieke pad van motion -> light.
- [ ] Cache invalidation uitvoeren na config revision change.
- [ ] Warmup bij worker start.

### Performance-eis
Motion-light processing op de server moet normaal enkele milliseconden kosten; netwerklatency mag het grootste clouddeel zijn.

---

## Fase 6 — Eerste Automation Engine: Lighting

### Waarom eerst Lighting
- tijdkritisch;
- makkelijk meetbaar;
- huidige lokale latency is al een aandachtspunt;
- goed geschikt om cloud fast-path te valideren.

### Werk
- [ ] Generieke motion/presence triggers.
- [ ] Room/device-role abstraction.
- [ ] Dag/avond/nacht profiles.
- [ ] Lux conditions.
- [ ] Overrides.
- [ ] Occupancy timeout.
- [ ] Redundante light commands onderdrukken.
- [ ] Deduplicatie van vrijwel gelijktijdige motion events.
- [ ] Timingmetingen van sensor event t/m lamp state.

### Latency SLO
- [ ] p50 motion -> gewenste HA service call < 100 ms cloud-added path waar netwerk dit toelaat.
- [ ] p95 end-to-end vastleggen en bewaken.
- [ ] p99 bewaken op regressies.

---

## Fase 7 — Presence Engine

### Werk
- [ ] Multi-sensor presence model.
- [ ] Telefoon/geofence als één input, niet absolute waarheid.
- [ ] Bewegingsactiviteit.
- [ ] Bed/pressure presence.
- [ ] Recent-activity windows.
- [ ] Per-room occupancy.
- [ ] Home occupancy state.
- [ ] Confidence/reason logging.
- [ ] Anti-flapping/hysteresis.

### Belangrijk
Presence-uitkomsten worden semantische states die andere engines gebruiken, in plaats van dat iedere flow zelf presence opnieuw uitrekent.

---

## Fase 8 — Alarm Engine + offline failsafe

### Cloud
- [ ] Centrale alarm policy.
- [ ] Auto-arm regels.
- [ ] Presence/security conditions.
- [ ] Entry/exit logic.
- [ ] Notifications.

### Lokaal
- [ ] `DISARMED`
- [ ] `ARMED_ONLINE`
- [ ] `ARMED_OFFLINE`
- [ ] `TRIGGERED`
- [ ] Bij verlies SmartAF heartbeat: `ARMED_ONLINE -> ARMED_OFFLINE`.
- [ ] In `ARMED_OFFLINE` geen nieuwe inbraaksirene triggeren.
- [ ] Geen auto-arm wanneer SmartAF service niet gezond bereikbaar is.
- [ ] Reeds `TRIGGERED` alarm niet automatisch stoppen door internetuitval.
- [ ] Handmatige disarm lokaal mogelijk houden.

Verwijs ook naar `TODO/cloud-alarm-offline-failsafe.md`.

---

## Fase 9 — Overige domein-engines

In volgorde op basis van hergebruik en risico:

- [ ] Cover/Curtain Engine.
- [ ] Climate/Ventilation Engine.
- [ ] Media Engine.
- [ ] Camera/Notification Engine.
- [ ] Vacuum Engine.
- [ ] Energy Engine.

Iedere engine:
- gebruikt device roles;
- bevat geen klant-id-specifieke code;
- heeft eigen schema/config;
- publiceert reason codes voor observability;
- heeft unit/integration tests.

---

## Fase 10 — Declaratieve Rule Engine

### Doel
Maatwerkautomations ondersteunen zonder nieuwe Node-RED-flow of codebranch per klant.

### Ondersteunde triggers
- [ ] entity/device state change
- [ ] duration/for
- [ ] time
- [ ] sunrise/sunset
- [ ] presence state
- [ ] numeric threshold
- [ ] event
- [ ] webhook/external event waar toegestaan

### Conditions
- [ ] equals/not equals
- [ ] numeric comparisons
- [ ] time window
- [ ] AND/OR/NOT
- [ ] presence/mode
- [ ] cloud availability
- [ ] device availability

### Actions
- [ ] turn_on/off/toggle
- [ ] light settings
- [ ] cover control
- [ ] media control
- [ ] climate control
- [ ] alarm actions
- [ ] camera snapshot
- [ ] notifications incl. attachment reference
- [ ] delays/waits
- [ ] scenes

### Workflow primitives
- [ ] sequence
- [ ] parallel
- [ ] delay
- [ ] wait_until
- [ ] condition gate
- [ ] if/else branch
- [ ] retry
- [ ] timeout
- [ ] outputs/results van eerdere stappen refereren

### Veiligheid
- [ ] Geen willekeurige JavaScript/Python/eval.
- [ ] Alleen whitelisted capabilities/actions.
- [ ] Max execution time.
- [ ] Max actions per run.
- [ ] Loop detection.
- [ ] Rate limiting.
- [ ] Rule schema versioning.

---

## Fase 11 — Rule Builder / beheerinterface

### Doel
Rules maken zonder JSON of Node-RED.

### UI-concept
```text
WANNEER
[ zon ] [ gaat onder ]

EN
[ iemand thuis ] [ ja ]

DAN
[ TV ] [ aan ]
[ Speaker ] [ speel avondmuziek ]
[ Woonkamerlampen ] [ rood ]
[ Gordijnen ] [ dicht ]
[ Rolluiken ] [ dicht ]
[ Alarm ] [ aan ]
[ Camera ] [ snapshot ]
[ Telefoon ] [ notificatie + snapshot ]
```

### Werk
- [ ] Admin-only eerste versie.
- [ ] Preview van gegenereerde rule.
- [ ] Validate vóór opslaan.
- [ ] Dry-run/simulate.
- [ ] Version history.
- [ ] Rollback.

---

## Fase 12 — Observability end-to-end

### Doel
Iedere vertraging en beslissing exact kunnen verklaren.

### Timingpunten
- [ ] sensor/event originated_at
- [ ] agent received_at
- [ ] gateway received_at
- [ ] engine start/end
- [ ] command sent_at
- [ ] agent command received_at
- [ ] HA service call_at
- [ ] target state confirmed_at

### Metrics
- [ ] motion -> light p50/p95/p99
- [ ] gateway RTT
- [ ] engine processing latency
- [ ] command failure rate
- [ ] unavailable entity rate
- [ ] reconnect rate
- [ ] duplicate/suppressed command count
- [ ] rule error rate

### Tracing
Iedere automation-run krijgt trace_id en reason codes.

---

## Fase 13 — Shadow mode migratie

### Doel
Cloudbeslissingen vergelijken met de huidige lokale Node-RED-logica zonder apparaten dubbel aan te sturen.

### Werk
- [ ] Lokale Node-RED blijft productie uitvoeren.
- [ ] Dezelfde events gaan ook naar SmartAF Cloud.
- [ ] Cloud berekent wat zij zou doen maar verstuurt geen command.
- [ ] Decisions vergelijken: local vs cloud.
- [ ] Timing vergelijken.
- [ ] Conflicten en onverwachte verschillen oplossen.

### Exit criteria
- Voor gemigreerde domeinen geen relevante decision mismatch meer over representatieve testperiode.

---

## Fase 14 — Controlled cutover per engine

Volgorde:
1. [ ] Lighting pilot.
2. [ ] Presence.
3. [ ] Covers/climate.
4. [ ] Alarm pas na uitgebreide fail-safe tests.
5. [ ] Rule Engine maatwerk.

Per engine:
- [ ] feature flag per woning;
- [ ] directe rollback naar lokaal;
- [ ] shadow compare vooraf;
- [ ] observability groen;
- [ ] geen dubbele command producers.

---

## Fase 15 — Node-RED uit klantproduct verwijderen

### Doel
Klanten bevatten uiteindelijk geen leesbare SmartAF automationflows.

### Werk
- [ ] Alle productiefunctionaliteit gemigreerd naar SmartAF Cloud/Agent.
- [ ] Node-RED alleen nog als interne development/reference tool indien nuttig.
- [ ] Geen Node-RED add-on installeren op klant-Greens.
- [ ] Geen flowfiles in klantbackups.
- [ ] Geen Node-RED credentials/endpoints op klantinstallaties.

---

## Fase 16 — Fleet management voor 100+ klanten

### Werk
- [ ] Overzicht online/offline homes.
- [ ] Agent version status.
- [ ] HA version status.
- [ ] Config revision.
- [ ] Engine version.
- [ ] Health/latency status.
- [ ] Remote diagnostics.
- [ ] Config rollout/rollback.
- [ ] Agent staged rollout.
- [ ] Alerts voor offline, high latency en command failures.

### Belangrijk ontwerpprincipe
100 klanten = 1 codebase + 100 configuraties + 100 identities, niet 100 forks.

---

## Fase 17 — High availability en productiehardening

### Werk
- [ ] Minimaal twee Gateway-instances.
- [ ] Meerdere stateless automation workers.
- [ ] Load balancing.
- [ ] PostgreSQL backups + point-in-time recovery.
- [ ] Config/state cache redundancy.
- [ ] Deployment zonder volledige downtime.
- [ ] Health probes.
- [ ] Server-side circuit breakers.
- [ ] DDoS/rate-limit basisbescherming.
- [ ] Secret management.
- [ ] Disaster recovery runbook.

---

## Fase 18 — Testmatrix

### Functioneel
- [ ] Verschillende entity_ids bij verschillende woningen.
- [ ] Verschillende device merken met dezelfde role.
- [ ] Klanten met ontbrekende modules.
- [ ] Klanten met veel custom rules.
- [ ] Parallelle en conditionele rule actions.

### Security
- [ ] Event van home A kan nooit in context home B worden uitgevoerd.
- [ ] Command voor home B wordt door agent A geweigerd.
- [ ] Expired/replayed command wordt geweigerd.
- [ ] Gecompromitteerde klantconfig kan geen willekeurige code uitvoeren.

### Netwerk
- [ ] 20 ms RTT.
- [ ] 100 ms RTT.
- [ ] packet loss.
- [ ] korte disconnect.
- [ ] lange internetuitval.
- [ ] flapperende verbinding.

### Load
- [ ] 100 gelijktijdig verbonden homes.
- [ ] 1.000 homes architectuurtest.
- [ ] motion/event bursts.
- [ ] grote hoeveelheid rule triggers.

---

## Eerste concrete implementatievolgorde

1. [ ] Fase 0: huidige flows classificeren.
2. [ ] Fase 1: protocol vastleggen.
3. [ ] Fase 2: SmartAF Agent persistent event/command transport.
4. [ ] Fase 3: minimale cloud Gateway.
5. [ ] Fase 4: PostgreSQL + home/device/role/config model.
6. [ ] Fase 5: in-memory config cache.
7. [ ] Fase 6: Lighting Engine als eerste werkende vertical slice.
8. [ ] Fase 12: volledige latency tracing voor die slice.
9. [ ] Fase 13: shadow mode naast huidige keuken/lichtlogica.
10. [ ] Daarna Presence Engine.
11. [ ] Daarna generieke Rule Engine.
12. [ ] Alarm Engine pas na bewezen transport, observability en offline failsafe.
13. [ ] Geleidelijke cutover en uiteindelijk Node-RED verwijderen uit klantproduct.

## Architectuurregels die niet overtreden mogen worden

1. Geen klant-specifieke `if home_id == ...` logica in engines.
2. Geen hardcoded HA entity_ids in centrale automationcode.
3. Geen databasequery in het time-critical motion-light fast path.
4. Geen willekeurige executable code in custom rules.
5. Geen cross-tenant state/config/cache zonder expliciete `home_id` scope.
6. Geen alarm auto-arm zonder bewezen gezonde SmartAF-service.
7. Geen productie-cutover zonder shadow-mode vergelijking en rollbackpad.
8. Geen Node-RED-flows op klant-Greens als eindarchitectuur.
9. Nieuwe capabilities worden generiek gebouwd en daarna via configuratie beschikbaar gemaakt.
10. Iedere belangrijke automationbeslissing moet traceerbaar zijn met reason code en timing.

## Definition of Done voor eerste commerciële serverversie

- [ ] Minimaal Lighting, Presence, Alarm en Rule Engine werken server-side.
- [ ] Klant-Green bevat geen Node-RED flows.
- [ ] Agent gebruikt unieke per-home identity.
- [ ] Configuraties zijn per woning geïsoleerd en versioned.
- [ ] Rule Engine kan trigger + conditions + sequence/parallel + camera snapshot + notification attachment uitvoeren.
- [ ] Alarm offline fail-safe is lokaal getest.
- [ ] Motion-to-light p50/p95/p99 zijn meetbaar en voldoen aan vastgestelde SLO's.
- [ ] Servercomponenten zijn redundant genoeg om een single-instance failure op te vangen.
- [ ] Rollback bestaat voor agent, config en engine releases.
- [ ] Fleet management kan minimaal 100 woningen overzichtelijk beheren.
