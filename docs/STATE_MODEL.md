# Datenpunkte und Nachrichtenschnittstelle

Dieses Dokument beschreibt das Datenpunktmodell von `velux-extended` 0.1.0. Die ausführende Implementierung liegt in [adapter-runtime.js](../lib/adapter-runtime.js); Werteprüfung und Payload-Aufbau stehen in [commands.js](../lib/commands.js), Produkterkennung und ID-Kodierung in [model.js](../lib/model.js). Protokollquellen und Signierung sind in [protocol.md](protocol.md) dokumentiert.

## Grundregeln

- Der Namespace einer ersten Instanz ist `velux-extended.0`. Die Tabellen unten zeigen Pfade relativ dazu.
- Ein Schreibbefehl hat `ack: false`. Empfangene Werte und verarbeitete Rückmeldungen werden mit `ack: true` geschrieben.
- Ein Button wird durch den booleschen Wert `true` ausgelöst. Der Adapter setzt ihn danach wieder auf `false`. Text `"true"` oder eine Zahl ist kein gültiger boolescher Befehl.
- Positionen sind ganze Zahlen in Prozent: **0 = geschlossen, 100 = offen**. Winkel sind ganze Grad von **−90 bis +90**. Der Adapter invertiert diese Werte nicht.
- Statuswerte entstehen nur, wenn die API entsprechende Daten liefert. Ein fehlender Wert ist keine Meldung `false`, 0 oder „geschlossen“.
- Berechtigungen und Fähigkeiten werden auch im Befehlsaufbau geprüft. Ein sichtbar gebliebener alter Datenpunkt garantiert keine weiterhin verfügbare Gerätefunktion.

### IDs und Namen

Homes, Gateways, Geräte, Räume und Zeitpläne erhalten einen stabilen Pfadteil nach diesem Schema:

```javascript
const safeId = 'id_' + Buffer.from(originalId, 'utf8').toString('base64url');
```

Gerätenamen sind nur Anzeigenamen. Die ursprünglichen Kennungen stehen in den jeweiligen `.id`-Datenpunkten beziehungsweise bei Zeitplänen in `native.scheduleId`. Bei der Nachrichtenschnittstelle und in der Gateway-Tabelle werden **Originalkennungen** verwendet, nicht die kodierten Pfadteile.

Bekannte Gruppen verwenden lesbare Namen wie `covers`, `windows` oder `venetian_blind`. Unbekannte Produkttypen werden für ihre Gruppen-ID kodiert. Die ursprüngliche Gruppenkennung steht in `native.group`.

In den Tabellen bedeuten `<home>`, `<gateway>`, `<device>`, `<room>` und `<schedule>` den tatsächlichen kodierten Pfadteil. Pfade am besten aus ioBroker **Objekte** kopieren.

## Instanz und Home

| Pfad | Zugriff / Typ | Bedeutung |
| --- | --- | --- |
| `info.connection` | lesen, boolean | Verbindung beziehungsweise erfolgreiche Statusabfrage der Cloud. Kein individueller Motorstatus. |
| `info.eventConnection` | lesen, boolean | Verbindung des Cloud-WebSocket. Polling funktioniert davon unabhängig. |
| `info.lastError` | lesen, string | Letzter allgemeiner Verbindungs- oder Befehlsfehler. |
| `info.lastUpdate` | lesen, number | Zeitpunkt der letzten Statusaktualisierung in Unixmillisekunden. |
| `refresh` | Button | Homes, Geräte und Zeitpläne neu einlesen. |
| `homes.<home>.id` | lesen, string | Originale Home-ID. |
| `homes.<home>.connection` | lesen, boolean | Statusabfrage dieses Homes erfolgreich. |
| `homes.<home>.lastUpdate` | lesen, number | Letzte Home-Aktualisierung in Unixmillisekunden. |
| `homes.<home>.raw` | lesen, JSON-Text | Bereinigte Rohdaten, wenn `rawData` aktiviert ist. Bekannte Geheimnis- und Standortfelder werden entfernt. |

Ein Home besitzt die Bereiche `gateways`, `devices`, `rooms` und `schedules`. Die Zuordnung jedes Befehls erfolgt anhand der Original-IDs dieses Homes. Der Adapter nimmt nicht pauschal das erste Gateway der ersten Cloudantwort.

### Befehlsdiagnose

Homes, Gateways, Geräte, Räume und Gruppen besitzen dieselben Diagnosefelder:

| Feld | Bedeutung |
| --- | --- |
| `lastCommand` | Bezeichnung des letzten Befehls in diesem Bereich. |
| `commandStatus` | Bearbeitungsstand gemäß folgender Tabelle. |
| `lastError` | Letzter Fehlertext dieses Bereichs; bei einer angenommenen Anfrage geleert. |
| `lastSuccess` | Zeitpunkt der letzten von der API angenommenen Anfrage, in Unixmillisekunden. |

| `commandStatus` | Bedeutung |
| --- | --- |
| `idle` | Seit Initialisierung noch kein Befehl in diesem Bereich. |
| `queued` | Befehl wartet in der Warteschlange des Homes. |
| `pending` | Anfrage wird aufgebaut beziehungsweise gesendet. |
| `accepted` | API hat die Anfrage angenommen. Die Wirkung ist damit noch nicht bestätigt. |
| `confirmed` | Ein nach dem Senden eingetroffener Status stimmt mit dem erwarteten Ergebnis überein. |
| `failed` | Validierung oder API meldet einen Fehler. |
| `cancelled` | Ein priorisierter Stopp hat einen noch nicht gesendeten Fahrbefehl verworfen. |
| `unknown` | Anfrageausgang oder Wirkung ist unklar, beispielsweise nach einem Netzwerkzeitlimit oder fehlender Zielbestätigung. |

Bei Positions-, Winkel-, Silent-, Modus- und Timerbefehlen prüft der Adapter erwartete Statuswerte. Bleibt die passende Rückmeldung innerhalb von drei Minuten aus, wird das Ergebnis `unknown`. Für Befehle ohne eindeutig prüfbaren Ergebniswert, beispielsweise Gateway-Stopp oder Szenen, bleibt `accepted` die erreichbare Bestätigung. Es wird keine künstliche Motorposition aus einer Laufzeitschätzung erzeugt.

Gruppenbefehle haben ihre Diagnose am Gruppenpfad. Bei den Bedienkürzeln direkt am Raum liegt sie am Raum. Zeitplanoperationen verwenden die Home-Diagnose.

## Gateways

Pfad: `homes.<home>.gateways.<gateway>`

| Feld | Zugriff / Typ | Wirkung oder Inhalt |
| --- | --- | --- |
| `id` | lesen, string | Originale Gateway-ID für Konfiguration und Nachrichten. |
| `type` | lesen, string | Gemeldeter Produkttyp, bei Gateways üblicherweise `NXG`. |
| `stopAll` | Button | `home.modules: [{id: gatewayId, stop_movements: "all"}]`. Stoppt Bewegungen gatewayweit. |
| `scenario` | schreiben, string | Eines der sechs unten genannten Szenarien ausführen. |
| `bedtime`, `wake_up`, `away`, `home`, `start_airing`, `stop_airing` | je ein Button | Direkte Alternative zum Schreiben von `scenario`. |
| `locked` | lesen, boolean | Gemeldete Verriegelung. Entriegelung erfolgt über die Szene `home`. |
| `locking` | lesen, boolean | Gemeldeter laufender Verriegelungsvorgang. |
| `reachable` | lesen, boolean | Gemeldete Erreichbarkeit des Gateways. |
| `isRaining` | lesen, boolean | Gemeldeter Regenstatus, wenn geliefert. Zeitlich verzögert möglich. |
| `pinEnabled` | lesen, boolean | Gemeldeter PIN-Aktivierungsstatus. Enthält keine PIN. |
| `lastUpdate` | lesen, number | Zeitpunkt des letzten empfangenen Modulstatus in Unixmillisekunden. |
| `lastSeen` | lesen, number | Von der Cloud gemeldeter Sichtkontakt, nach Unixmillisekunden umgerechnet. |

Zusätzlich können Firmware-, Funk- und Sensordaten erscheinen. `stopAll` betrifft ausschließlich das adressierte Gateway, dort aber alle fahrenden Produkte. Er wird nicht als Ersatz für einen Geräte-Stopp aufgerufen.

### Szenariowerte

| Wert | Aufruf | Geschützter Befehl |
| --- | --- | --- |
| `bedtime` | Gute Nacht | nein |
| `wake_up` | Guten Morgen | nein |
| `away` | Abwesenheit / Verriegeln | nein |
| `home` | Zuhause / Entriegeln | ja |
| `start_airing` | Lüften starten | ja |
| `stop_airing` | Lüftszenario beenden | nein |

Geschützte Szenen benötigen den passenden Gateway-Schlüssel. Der Name `stop_airing` beschreibt ein Szenario. Der Bewegungsstopp verwendet den anderen Schlüssel `stop_movements`.

### Kopplung

| Feld | Zugriff / Typ | Bedeutung |
| --- | --- | --- |
| `pairing.start` | Button | Schlüsselabruf über die Cloud vorbereiten; danach auf das Blinksignal warten und die physische Taste drücken. |
| `pairing.confirm` | Button | Nach dem physischen Tastendruck den lokalen Abruf starten. |
| `pairing.cancel` | Button | Einen begonnenen Kopplungsvorgang abbrechen. |
| `pairing.status` | lesen, string | Fortschritt, unter anderem `awaiting_button`, oder Fehlerzustand. |
| `pairing.keyAvailable` | lesen, boolean | Ein Schlüssel ist intern für dieses Home/Gateway gespeichert. Dies ist kein erfolgreicher Hardwaretest des Schlüssels. |

Die zugehörige originale Gateway-ID und der lokale Host stehen in der Admin-Tabelle. Die Anleitung in der [README](../README.md#gateway-koppeln) beschreibt die Reihenfolge. Der Adapter speichert Schlüssel, Signaturzähler und erneuerte Tokens verschlüsselt in einem internen Zugangsdatenobjekt. Es gibt keinen lesbaren Schlüssel-State.

## Geräte

Pfad: `homes.<home>.devices.<device>`

Dieser Bereich enthält Fenster, Rollos, Jalousien, Sensoren und weitere Module. Fahrbefehle werden nur für erkannte Öffnungsprodukte angelegt.

| Feld | Zugriff / Typ | Bedeutung / Grenzen |
| --- | --- | --- |
| `id` | lesen, string | Originale Modul-ID. |
| `type` | lesen, string | Gemeldeter `velux_type`, ersatzweise Modultyp. |
| `position` | lesen, number | `current_position` in Prozent. Rolle `value.blind`. |
| `targetPosition` | lesen/schreiben, number | Ziel 0…100 %, nur ganzzahlig. Rolle `level.blind`. |
| `open` | Button | Zielposition 100. |
| `close` | Button | Zielposition 0. |
| `stop` | Button, optional | Experimenteller Einzelstopp mit `target_position: -1`; nur bei aktivierter Instanzoption. |
| `silent` | lesen/schreiben, boolean | Leiser Betrieb, wenn `silent` im Status als boolean geliefert wird. |
| `orientation` | lesen, number | Gemeldeter Lamellenwinkel in Grad, sofern vorhanden. |
| `targetOrientation` | lesen/schreiben, number | Lamellenziel von −90 bis +90 Grad, ganzzahlig. Rolle `level.tilt`. |
| `reachable` | lesen, boolean | Gemeldete Erreichbarkeit. Rolle `indicator.reachable`. |
| `busy` | lesen, boolean | Gemeldeter Beschäftigungs-/Bewegungsstatus. Rolle `indicator.working`. |
| `calibrating` | lesen, boolean | Gemeldete Kalibrierung. |
| `mode` | lesen, string | Gemeldeter Modus. Der Raum besitzt den gesonderten Automatikschalter. |
| `lastUpdate`, `lastSeen` | lesen, number | Zeitstempel in Unixmillisekunden, sofern geliefert. |
| `controlledOpeners` | lesen/schreiben, string, optional | Für passend konfigurierte NXS-Module: `windows` oder `external_covers`. |

Geschützte Dachfensterpositionen ungleich 0 werden signiert. Das gilt auch für den experimentellen Einzelstopp. Silent und Lamellen werden nicht jedem Rollo zugeschrieben. Für den Lamellenschreibpfad verlangt die Umsetzung `velux_type: "venetian_blind"` und `firmware_revision_netatmo >= 55` am zugehörigen Gateway.

Der NXS-Schreibpfad verwendet `setconfigs`, nicht den normalen `setstate`-Endpunkt. Ein NXS-Modul muss einen der unterstützten `controlled_openers`-Werte in seiner Konfiguration melden, bevor der Datenpunkt bereitgestellt wird.

## Räume und Gruppen

Pfad: `homes.<home>.rooms.<room>`

| Feld | Zugriff / Typ | Bedeutung / Grenzen |
| --- | --- | --- |
| `id` | lesen, string | Originale Raum-ID. |
| `mode` | lesen, string | Unveränderter gemeldeter Raummodus. |
| `automation` | lesen/schreiben, boolean | `true` schreibt `algo_available`, `false` schreibt `manual`. |
| `autoCloseMinutes` | schreiben, number | Ganze Minuten 0…1440 ab jetzt; 0 hebt den Timer auf. |
| `autoCloseAt` | lesen/schreiben, number | Absoluter Schließzeitpunkt in **Unixsekunden**; 0 hebt den Timer auf. Ein neuer Zeitpunkt muss in den nächsten 24 Stunden liegen. |
| `remainingSeconds` | lesen, number | Nichtnegative Restzeit aus dem zuletzt bekannten `auto_close_ts` und der ioBroker-Systemzeit. |
| `cancelAutoClose` | Button | `auto_close_ts: 0` setzen. Stoppt keinen fahrenden Motor. |
| `airForMinutes` | schreiben, number, optional | Alle Fenster des Raums auf 100 % öffnen und in derselben Anfrage einen Raum-Schließtimer setzen; 1…1440 ganze Minuten. |
| `targetPosition`, `open`, `close` | wie Gerätesteuerung | Bedienkürzel für die Raumgruppe `covers`, also Beschattung ohne Fenster. |
| `targetOrientation` | schreiben, number, optional | Lamellenziel der geeigneten Beschattungsprodukte im Raum. |
| `algo_status`, `algo_schedule_start` | lesen | Weitere Algorithmusangaben, wenn von der API geliefert. |

Der Lesewert von `automation` wird für `algo_available` oder `algo_active` als `true` und für `manual` oder `algo_disabled` als `false` abgebildet. Andere Moduswerte werden nicht frei interpretiert. Der direkte `mode`-Datenpunkt bleibt lesbar.

`autoCloseMinutes` und `autoCloseAt` allein ändern nur den Timer. `airForMinutes` kombiniert ausdrücklich Fensteröffnung und Timer und benötigt für die Öffnung gekoppeltes Schlüsselmaterial. Über `groupCommand` kann statt 100 % eine kleinere Öffnungsposition mit einer Dauer kombiniert werden.

### Gruppenpfade

Unter `rooms.<room>.groups.<group>` liegen `targetPosition`, `open`, `close` und bei geeigneten Produkten `targetOrientation`. Eine Gruppe wird nur angelegt, wenn sie passende Geräte enthält.

| Gruppe | Mitglieder |
| --- | --- |
| `covers` | Erkannte Öffnungsprodukte des Raums, deren `velux_type` nicht `window` ist. |
| `windows` | Fenster mit `velux_type: "window"`. |
| Ein vorhandener Produkttyp, beispielsweise `venetian_blind` | Geräte mit genau diesem `velux_type`. |

Bei einer Winkelanfrage berücksichtigt der Adapter nur Mitglieder, die das Lamellenkriterium erfüllen. Vor dem Senden einer Gruppenanfrage müssen alle benötigten Geräteschlüssel und Zielwerte geprüft sein. Die Cloud kann trotzdem Fehler pro Modul zurückmelden; gleichzeitige Zielankunft wird nicht zugesagt.

## Sensoren und gemeldete Einstellungen

Messwerte liegen unter `.sensors.<api_field>` des Geräts, Gateways oder Raums, das den Wert liefert. Alle sind lesbar. Nicht jedes Produkt liefert dieselben Werte.

| Feld | Einheit / Behandlung |
| --- | --- |
| `temperature` | °C; API-Wert wird durch 10 geteilt. |
| `humidity` | % |
| `co2` | ppm |
| `lux` | lx |
| `air_quality` | Gemeldeter Zahlencode ohne erfundene Klartextskala. |
| `battery_percent` | % |
| `battery_level` | mV |
| `rf_strength`, `wifi_strength` | Gemeldete Zahlenwerte, ohne angenommene Prozentnormalisierung. |
| `min_comfort_temperature`, `max_comfort_temperature` | °C; API-Wert wird durch 10 geteilt. |
| `min_comfort_humidity`, `max_comfort_humidity` | % |
| `max_comfort_co2` | ppm |

Komfortgrenzen werden in dieser Version als gemeldete Werte bereitgestellt. Daraus entsteht kein zusätzlicher Schreibbefehl für diese Felder. Textwerte wie `battery_state`, `rf_state` und Firmwareangaben liegen direkt am jeweiligen Modul.

## Zeitpläne

Wurzel: `homes.<home>.schedules`

| Pfad | Zugriff / Typ | Bedeutung |
| --- | --- | --- |
| `activeId` | lesen, JSON-Text | Array der als aktiv gemeldeten Original-Plan-IDs. Der Name ist im Singular, der Inhalt kann mehrere IDs enthalten. |
| `nextEvent` | lesen, JSON-Text | Gemeldetes nächstes Ereignis, gegebenenfalls `null`. |
| `create` | schreiben, JSON-Text | Neuen `event`- oder `algo`-Plan anlegen. |
| `<schedule>.name` | lesen, string | Aktueller Planname. |
| `<schedule>.active` | lesen, boolean | Plan wird als aktiv/ausgewählt gemeldet. |
| `<schedule>.definition` | lesen, JSON-Text | Bereinigte vorhandene Planstruktur. |
| `<schedule>.activate` | Button | Diesen Plan über `switchhomeschedule` aktivieren. |
| `<schedule>.rename` | schreiben, string | Neuen Namen setzen, 1…128 Zeichen nach Trimmen. |
| `<schedule>.update` | schreiben, JSON-Text | Vorhandene Definition ändern. Fehlende Felder werden aus dem zuletzt eingelesenen Plan ergänzt. |
| `<schedule>.delete` | Button | Diesen Plan tatsächlich aus der Cloud löschen. |

Die äußere Schreibstruktur für `create` ist:

```text
{
  name: nichtleerer Text,
  schedule_type: "event" oder "algo",
  zones: Array im VELUX-Zonenschema,
  timetable: Array im VELUX-Zeitrasterschema
}
```

Dies ist eine Schemaskizze, kein ausführbares JSON-Beispiel. Die verschachtelten Inhalte aus einer vorhandenen `definition` übernehmen und gezielt ändern. Der Adapter kennt nicht jede Produktkombination innerhalb von Zonen und validiert nicht sämtliche internen Zeitplanregeln. Die Cloud kann eine äußerlich gültige Struktur ablehnen.

Bei `update` ist die Plan-ID durch den Datenpunkt festgelegt; im JSON kann sie nicht auf einen anderen Plan umgebogen werden. Definitionen sind auf 256 KiB begrenzt. Zeitplanergebnisse erscheinen in der Diagnose des Homes, nach einem erfolgreichen API-Aufruf werden die Cloudinformationen neu eingelesen.

## Nachrichtenschnittstelle für Skripte

Nachrichten verwenden Original-IDs. Beispiel für den JavaScript-Adapter:

```javascript
sendTo('velux-extended.0', 'groupCommand', {
    homeId: 'ORIGINALE_HOME_ID',
    roomId: 'ORIGINALE_RAUM_ID',
    group: 'windows',
    action: 'position',
    value: 30,
    durationMinutes: 15
}, response => {
    if (response.error) log(response.error, 'warn');
});
```

Das Beispiel öffnet die passenden Fenster auf 30 % und setzt denselben Raumtimer in einer Anfrage. Die benötigten Gateway-Schlüssel müssen vorhanden sein. `durationMinutes` ist nur bei reinen Fenstergruppen zulässig.

| Nachricht | Nutzdaten |
| --- | --- |
| `discover` | `{}`; Topologie, Status und Zeitpläne neu einlesen. |
| `refresh` | `{}`; Status erneut abfragen. |
| `getTopology` | `{}`; bereinigten aktuellen Modellstand zurückgeben. |
| `deviceCommand` | `{homeId, moduleId, action, value?}`; Aktionen `position`, `open`, `close`, `stop`, `silent`, `orientation`. |
| `gatewayCommand` | `{homeId, gatewayId, action, value?}`; `stopAll` oder `scenario` mit Szenarioname. |
| `roomCommand` | `{homeId, roomId, action, value?}`; `automation`, `autoCloseMinutes`, `autoCloseAt`, `cancelAutoClose`. |
| `groupCommand` | `{homeId, roomId, group?, action, value?, durationMinutes?}`; Standardgruppe `covers`; Aktionen `position`, `open`, `close`, `orientation`. |
| `setControlledOpeners` | `{homeId, moduleId, value}` mit `windows` oder `external_covers`. |
| `pairGateway` | `{homeId, gatewayId, phase?}`; `prepare` (Standard), nach physischer Bestätigung `confirm`, oder `cancel`. |
| `setPin` | `{homeId, gatewayId, pin}`; signierten PIN-Befehl senden. `pin` ist ein nichtleerer Text. Keine PIN im normalen State-Modell. |
| `schedule` | `{homeId, action, definition}`; Aktionen `create`, `update`, `rename`, `delete`, `switch`. |

Bei `schedule` enthält `definition` für vorhandene Pläne `schedule_id`. Für `rename` kommt `name` hinzu; `create` und `update` verwenden die oben beschriebene Planstruktur. Bei `create` ist keine bestehende Plan-ID erforderlich.

```javascript
sendTo('velux-extended.0', 'schedule', {
    homeId: 'ORIGINALE_HOME_ID',
    action: 'switch',
    definition: { schedule_id: 'ORIGINALE_PLAN_ID' }
}, response => {
    if (response.error) log(response.error, 'warn');
});
```

Erfolgreiche Cloud-Schreibbefehle liefern `{accepted: true, result: ...}`. Das ist eine API-Annahme, keine garantierte Gerätewirkung. Fehler liefern `{error: "...", code: "..."}`. Discovery, Topologie und Kopplung verwenden passende eigene Rückgaben. Die weiteren Statusbestätigungen erscheinen in den oben beschriebenen Diagnosefeldern.

PIN-Nachrichten nicht als normale Zustände speichern oder ihre Nutzdaten protokollieren. `setPin` sendet den Gateway-PIN-Schreibpfad und ersetzt keine lokale Entsperrung des Android-App-Keystores. Ein gespeicherter Gateway-Schlüssel und ein bestimmbares Signaturverfahren sind auch hierfür erforderlich.

## Wichtige Fehlermeldungen

| Code | Bedeutung |
| --- | --- |
| `PAIRING_REQUIRED` | Für den geschützten Befehl fehlt der Gateway-Schlüssel. |
| `UNKNOWN_SIGNING_SCHEME` | Automatische Bestimmung des Signaturverfahrens ist mit der gemeldeten Firmware nicht möglich. |
| `INDIVIDUAL_STOP_DISABLED` | Einzelstopp ist in der Instanzkonfiguration nicht freigegeben. |
| `UNSUPPORTED` | Gerät oder Konfiguration erfüllt das Fähigkeitskriterium nicht. |
| `INVALID_VALUE` | Wert, Typ, Zahlenbereich oder JSON-Grundstruktur ist ungültig. |
| `UNKNOWN_HOME`, `UNKNOWN_DEVICE`, `UNKNOWN_ROOM`, `UNKNOWN_SCHEDULE` | Originalkennung ist im aktuellen Modell nicht vorhanden. |
| `AMBIGUOUS_GATEWAY`, `GATEWAY_NOT_FOUND` | Ein Gerät kann keinem eindeutigen vorhandenen Gateway zugeordnet werden. |
| `EMPTY_GROUP` | Keine passenden Produkte für den Gruppenbefehl. |
| `CANCELLED_BY_STOP` | Noch nicht gesendete Fahrt wurde zugunsten eines Stopps verworfen. |
| `TIMEOUT`, `NETWORK_ERROR` | Anfrageausgang kann unklar sein. Status prüfen, bevor ein Befehl bewusst erneut ausgelöst wird. |

Bei einem Verbindungsabbruch werden Fahrbefehle nicht allein wegen des Abbruchs blind erneut gesendet. Die konkreten Authentifizierungs- und Fehlerregeln sind im [Client](../lib/client.js) umgesetzt. API-Antworten mit Fehlern pro Modul werden als Fehler behandelt, auch wenn die HTTP-Anfrage technisch erfolgreich war.
