# SmartAF Home Assistant Apps

Publieke installatierepository voor de SmartAF Node-RED Deploy Agent en de SmartAF Local Agent.

De huislogica, entiteiten en deployments staan niet in deze repository. Die
blijven in de private repository `nizarautomated/home-assistant-node-red`.

## Installeren

Voeg deze repository toe in de Home Assistant app-winkel:

`https://github.com/nizarautomated/smartaf-ha-addon`

Installeer voor de bestaande beheer- en migratiefuncties **SmartAF Node-RED Deploy Agent** en vul een fine-grained GitHub-token in met **Contents: Read and write** voor uitsluitend de private deploymentrepository.

De nieuwe **SmartAF Local Agent** is de transportlaag voor de server-only architectuur. Installeer deze pas nadat SmartAF een unieke woningidentity, agentidentity, token en werkende HTTPS-serveringang heeft uitgegeven.
