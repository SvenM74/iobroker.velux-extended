# VELUX Extended für ioBroker

<img src="admin/velux-extended.png" alt="VELUX Extended" width="200">

`iobroker.velux-extended` bindet VELUX ACTIVE Geräte über die VELUX/Netatmo-Cloud in ioBroker ein. Der Adapter ergänzt ausdrückliche Steuerbefehle, Gateway-Stopp, Raum- und Gruppensteuerung, Live-Ereignisse und die lokale Schlüsselkopplung für signierte Fensterbefehle.

**Version 0.1.0 ist ein erster Entwicklungsstand.** Protokollaufbau und Verhalten werden mit automatisierten Tests und aufgezeichneten Quellbefunden geprüft. Tests an einem echten Gateway, Fahrten realer Geräte und eine erfolgreiche Installation in einer produktiven ioBroker-Instanz stehen noch aus. Der Adapter ist ein unabhängiges Projekt und kein offizielles VELUX- oder Netatmo-Produkt.

Die Bedienung verwendet **0 % = geschlossen, 100 % = offen**. `stopAll` stoppt alle laufenden Bewegungen am gewählten Gateway. Der gesonderte Stopp eines einzelnen Geräts ist experimentell und standardmäßig deaktiviert.

[Datenpunktmodell](docs/STATE_MODEL.md) · [Protokoll und Signierung](docs/protocol.md) · [English overview](#english-overview)

## Funktionen

Die folgende Tabelle beschreibt die implementierten Befehle und ihre Grenzen. Die Payloads sind in [lib/commands.js](lib/commands.js), die API-Aufrufe in [lib/client.js](lib/client.js) und die Zuordnung zu ioBroker in [lib/adapter-runtime.js](lib/adapter-runtime.js) nachvollziehbar.

| Funktion | Bedienung und Voraussetzung |
| --- | --- |
| Position, Öffnen, Schließen | Eigene Befehle pro Gerät; ganzzahlige Position von 0 bis 100 %. Home und Gateway werden pro Gerät zugeordnet. |
| Gateway-Stopp | `gateways.<gateway>.stopAll` sendet `stop_movements: "all"` an genau dieses Gateway. Kann mehrere Fenster und Rollos anhalten. |
| Experimenteller Einzelstopp | `devices.<device>.stop` verwendet `target_position: -1`, wenn die Instanzoption eingeschaltet ist. Dieser Einzelbefehl ist nicht durch den untersuchten APK-Stopp-Pfad bestätigt. |
| Dachfenster öffnen | Geschützte Positionsbefehle benötigen einen gekoppelten Gateway-Schlüssel. Der Adapter unterstützt HMAC- und älteres SHA512-Verfahren. Schließen mit Position 0 wird ohne Positionssignatur erstellt. |
| Live-Status | Cloud-WebSocket mit regelmäßiger REST-Abfrage als Ergänzung und Rückfall. Das ist keine lokale Echtzeitverbindung zum Motor. |
| Raum- und Gruppensteuerung | Mehrere passende Geräte in einer Cloudanfrage ansteuern. Fenster, Beschattung und bestimmte Produkttypen erhalten getrennte Gruppen. |
| Leiser Betrieb | Schreibbarer `silent`-Schalter, wenn das Gerät diesen Modus im Status meldet. |
| Lamellenwinkel | `targetOrientation` von −90 bis +90 Grad für passende Jalousien. Der Adapter prüft Produkttyp `venetian_blind` und interne Gateway-Firmwarerevision ab 55. |
| Raumautomatik | `automation = true` setzt `mode: "algo_available"`, `false` setzt `"manual"`. Der tatsächliche Algorithmusstatus bleibt separat lesbar. |
| Automatisches Schließen | Raumbezogenen Schließzeitpunkt setzen, Dauer in Minuten angeben oder Timer aufheben. Ein Timerabbruch ist kein Bewegungsstopp. |
| Szenen | `bedtime`, `wake_up`, `away`, `home`, `start_airing`, `stop_airing`. `home` und `start_airing` benötigen Signierung. |
| Zeitpläne | Vorhandene Pläne lesen, aktivieren, umbenennen, erstellen, aktualisieren und löschen. Erstellen und Aktualisieren verwenden das VELUX-JSON-Schema für `event`- und `algo`-Pläne. |
| NXS-Steuerbereich | Bei passender gemeldeter Konfiguration zwischen `windows` und `external_covers` wechseln. |
| Diagnose und Sensordaten | Empfangene Raum- und Gerätestatuswerte mit Typen und Einheiten bereitstellen; zusätzliche bereinigte JSON-Rohdaten sind optional. Nicht jedes Gerät liefert alle Felder. |

Eine Funktion wird durch den Adapter implementiert, aber erst durch einen Hardwaretest für eine konkrete Gateway- und Gerätekombination bestätigt. Welche Prüfungen reproduzierbar sind und welche Quellen zugrunde liegen, steht unter [Entwicklung und Nachweise](#entwicklung-und-nachweise).

## Voraussetzungen

- ioBroker mit **Node.js 22.19.0 oder neuer**, **js-controller 7.2.2 oder neuer** und **Admin 6 oder neuer**. Die CI prüft Node.js 22 und 24.
- Ein VELUX ACTIVE Konto mit den bereits eingerichteten Homes, Gateways und Geräten.
- Internetzugriff des ioBroker-Hosts auf die VELUX/Netatmo-Cloud.
- Für die Schlüsselkopplung zusätzlich die lokale Gateway-IP oder einen auflösbaren Hostnamen, Erreichbarkeit von TCP-Port `25050` und Zugriff auf die physische Gateway-Taste.

Der Adapter ersetzt die Einrichtung neuer Produkte in der VELUX-App nicht. Die Cloudanmeldung bleibt auch nach erfolgreicher lokaler Kopplung erforderlich.

## Installation aus GitHub

Diese Entwicklungsversion wird direkt aus dem Repository installiert. Eine Veröffentlichung im npm-Register oder im offiziellen ioBroker-Adapterverzeichnis gehört nicht zu dieser Version.

### In ioBroker Admin

1. Die Seite **Adapter** öffnen und den Expertenmodus aktivieren, falls die Funktion zum Installieren über eine URL ausgeblendet ist.
2. **Von eigener URL installieren** öffnen und diese Repository-URL eingeben:

   ```text
   https://github.com/SvenM74/iobroker.velux-extended
   ```

3. Die Installation abschließen und eine Instanz von **VELUX Extended** anlegen, falls noch keine existiert.
4. Die Instanzkonfiguration öffnen und die Anmeldedaten eintragen.

Die genaue Bezeichnung der URL-Schaltfläche hängt von der Admin-Version ab. Als Alternative steht die ioBroker-Kommandozeile zur Verfügung.

### Über die ioBroker-Kommandozeile

Auf dem ioBroker-Host im Kontext der bestehenden ioBroker-Installation ausführen:

```bash
iobroker url https://github.com/SvenM74/iobroker.velux-extended
iobroker add velux-extended
```

Der zweite Befehl legt eine Instanz an und ist nur nötig, wenn noch keine gewünscht vorhandene Instanz existiert. Nach einer späteren Installation derselben Repository-URL die bestehende Instanz verwenden. Die [offizielle ioBroker-CLI-Dokumentation](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/config/cli.md) erklärt die Verwaltung von Instanzen.

Die Namespace-Bezeichnung lautet `velux-extended.0`, entsprechend mit anderer Nummer bei weiteren Instanzen. Der vorhandene Adapter `velux.0` wird durch die Installation nicht automatisch ersetzt. Bestehende Skripte und Visualisierungen müssen auf die neuen Datenpunkte umgestellt werden; es gibt keine automatische Migration alter Objekt-IDs.

## Konfiguration

| Feld | Standard | Bedeutung |
| --- | --- | --- |
| E-Mail / Passwort | leer | Anmeldung mit dem VELUX ACTIVE Konto. |
| Refresh-Token | leer | Alternative Token-Anmeldung. Wenn vorhanden, wird zunächst dieser Token verwendet. |
| OAuth-Client-ID / Client-Secret | leer | Optionale zusammengehörige Werte eines eigenen kompatiblen Clients. Normalerweise beide leer lassen. |
| Abfrageintervall | 60 Sekunden | Regelmäßige Statusabfrage; mindestens 15 Sekunden. Bleibt bei aktivem Ereignisstrom eingeschaltet. |
| Zeitlimit je Anfrage | 15 Sekunden | Zeitlimit für Cloud-HTTP-Anfragen. |
| Live-Ereignisse | ein | Statusänderungen zusätzlich über den Cloud-WebSocket empfangen. |
| Experimenteller Einzelstopp | aus | Den gesonderten Stopp pro Gerät erlauben. Hat keinen Einfluss auf `stopAll`. |
| Fahrbefehle mit `force` | aus | Fahrbefehle mit `force: true` versehen. Daraus folgt keine Garantie, dass Cloud oder Gateway jede Fahrt zulassen. |
| Cloudrohdaten | aus | Zusätzliche bereinigte Antwortdaten als JSON bereitstellen. |
| Lokale Gateways | leere Tabelle | Zuordnung aus originaler Gateway-ID, lokalem Host und Signaturverfahren für die Kopplung. |

Passwort, Refresh-Token und Client-Secret sind in `io-package.json` sowohl als `encryptedNative` als auch als `protectedNative` markiert. Lokales Schlüsselmaterial wird separat verschlüsselt in einem internen Zugangsdatenobjekt gespeichert. Es gibt keine normalen Datenpunkte zum Anzeigen oder Eingeben von Signaturschlüsseln. Für die Diagnose werden bekannte Geheimnisfelder aus zusätzlichen Rohdaten entfernt. Rohdaten können weiterhin Gerätekennungen und Namen enthalten.

## Gateway koppeln

Eine Kopplung wird benötigt, sobald geschützte Fensterbewegungen oder geschützte Szenen verwendet werden sollen. Der Gateway-Stopp benötigt diese Positionssignierung nicht.

1. Die Cloudanmeldung einrichten, speichern und warten, bis Homes und Geräte unter **Objekte** angelegt sind.
2. Im Tab **Gateway-Kopplung** eine Zeile anlegen. Als `Gateway-ID` die originale Kennung aus den Objektdaten verwenden; der für ioBroker kodierte Pfadteil `id_…` ist dafür nicht geeignet. Die lokale IP-Adresse oder den Hostnamen eintragen.
3. Als Signaturverfahren zunächst **Automatisch anhand der Firmware** wählen. Der Adapter verwendet bei interner Netatmo-Firmwarerevision ab 60 HMAC, ab 27 das ältere SHA512-Verfahren. Kann er das Verfahren nicht ableiten, muss ein für das Gateway bestätigtes Verfahren ausgewählt werden. Die Zahlen sind interne Gateway-Revisionsnummern, keine App-Versionen.
4. Einstellungen speichern. Unter `homes.<home>.gateways.<gateway>.pairing.start` einmal `true` mit `ack: false` schreiben.
5. Auf das Blinksignal am Gateway warten und die physische Taste drücken. `pairing.start` fordert zunächst nur die Schlüsselbereitstellung über die Cloud an; `pairing.status` wechselt auf `awaiting_button`.
6. Erst nach dem Tastendruck `pairing.confirm` auf `true` setzen. Damit führt der Adapter den lokalen Schlüsselaustausch über TCP `25050` durch. `pairing.status` und `pairing.keyAvailable` beobachten.
7. Bei Bedarf mit `pairing.cancel = true` abbrechen. Nach erfolgreicher Kopplung ist ein vorsichtiger Funktionstest eines einzelnen Geräts möglich.

Die Kopplung erfolgt pro Gateway. Eine Änderung der IP-Adresse allein ersetzt keinen Schlüssel. Wenn Schlüssel ungültig geworden sind, den Kopplungsvorgang erneut durchführen. Netzwerkfilter oder getrennte VLANs müssen die lokale Verbindung zwischen ioBroker und dem vorgesehenen Gateway zulassen.

Der Adapter extrahiert keine Schlüssel aus einem Android-Gerät. Die App-interne PIN- und Keystore-Entsperrung ist nicht Teil dieser Kopplung. Technische Details und Grenzen des implementierten Austauschs stehen in [docs/protocol.md](docs/protocol.md).

## Steuerung in ioBroker

### Schreibbefehle und tatsächlicher Zustand

Alle Befehle werden mit `ack: false` geschrieben. Rückmeldungen mit `ack: true` sind Statuswerte und lösen keine neue Fahrt aus. `position` ist die gemeldete Istposition; `targetPosition` ist der Sollwert. Eine angenommene Cloudanfrage bedeutet noch nicht, dass der Motor bereits am Ziel steht.

Die Beispiele enthalten Platzhalter für die tatsächlichen Objektpfade. Den passenden Pfad aus **Objekte** kopieren. Die Objekt-IDs enthalten stabile, kodierte Originalkennungen, damit Sonderzeichen und gleiche Gerätenamen nicht zu Verwechslungen führen.

```javascript
// ioBroker JavaScript-Adapter: Platzhalter durch echte Objektpfade ersetzen.
const device = 'velux-extended.0.homes.<home>.devices.<device>';
setState(`${device}.targetPosition`, 50, false);
```

`open` und `close` werden mit `true` ausgelöst. `targetPosition` akzeptiert nur ganze Zahlen von 0 bis 100. `-1` ist kein zulässiger Positionswert dieses Datenpunkts; für den experimentellen Einzelstopp existiert der eigene Befehl `stop`.

Die Semantik entspricht den [offiziellen ioBroker-Rollen](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/stateroles.md): `value.blind` beziehungsweise `level.blind` verwenden hier 0 für vollständig geschlossen und 100 für vollständig geöffnet. Eine zusätzliche Prozentinvertierung ist nicht nötig.

### Laufende Bewegung stoppen

```javascript
const gateway = 'velux-extended.0.homes.<home>.gateways.<gateway>';
setState(`${gateway}.stopAll`, true, false);
```

Dieser Befehl adressiert das Gateway mit `stop_movements: "all"`. Er kann alle dort fahrenden Fenster, Rollos und Jalousien betreffen. Der Adapter priorisiert ihn gegenüber noch nicht gesendeten Fahrbefehlen desselben Gateways und verwirft diese wartenden Fahrten. Eine bereits an die Cloud übermittelte Anfrage kann er nicht zurückholen.

Für `devices.<device>.stop` muss **Experimentellen Einzelstopp erlauben** aktiviert sein. Die Implementierung sendet dann `target_position: -1`; bei geschützten Dachfenstern kommt die Signatur hinzu. Der APK-Befund bestätigt den Gateway-Stopp, nicht die gerätespezifische Wirkung von `-1`. Die beiden Befehle haben deshalb unterschiedliche Namen und werden nicht automatisch gegeneinander ausgetauscht.

### Räume, Gruppen und Automatik

Ein Raum besitzt getrennte Gruppen für Beschattung (`covers`), Fenster (`windows`) und vorhandene Produkttypen. Die Raumkürzel `targetPosition`, `open` und `close` steuern die Beschattungsgruppe. Für Fenster die ausdrückliche Fenstergruppe verwenden. Gruppenbefehle bündeln mehrere Modulobjekte in einer Anfrage; die tatsächlichen Ankunftszeiten der Motoren sind dadurch nicht synchron garantiert.

```javascript
const room = 'velux-extended.0.homes.<home>.rooms.<room>';
setState(`${room}.groups.windows.targetPosition`, 30, false);
setState(`${room}.automation`, true, false);
```

`automation = true` erlaubt die Raumautomatik (`algo_available`); `false` fordert den manuellen Modus (`manual`) an. `mode` gibt den gemeldeten Zustand wieder, der beispielsweise auch `algo_active` oder `algo_disabled` sein kann. Ein gemeldeter Statusname ist nicht automatisch ein gültiger Schreibbefehl.

### Automatisches Schließen

`autoCloseMinutes` setzt einen raumbezogenen Schließzeitpunkt relativ zur aktuellen Zeit. Zulässig sind ganze Zahlen von 0 bis 1440; 0 hebt den Timer auf. `autoCloseAt` verwendet **Unixsekunden**, also Sekunden seit dem 1. Januar 1970. Ein neuer Zeitpunkt muss in den kommenden 24 Stunden liegen; 0 hebt den Timer auf.

```javascript
const room = 'velux-extended.0.homes.<home>.rooms.<room>';
setState(`${room}.autoCloseMinutes`, 15, false);
// Alternativ einen absoluten Zeitpunkt in Unixsekunden verwenden:
setState(`${room}.autoCloseAt`, Math.floor(Date.now() / 1000) + 15 * 60, false);
// Timer wieder aufheben:
setState(`${room}.cancelAutoClose`, true, false);
```

Das Setzen eines Timers öffnet kein Fenster von selbst. `cancelAutoClose` beendet keinen laufenden Motorbefehl; es setzt den Raumwert `auto_close_ts` auf 0. Die verbleibende Zeit wird unter `remainingSeconds` bereitgestellt. Der Timer gehört zum Raum, nicht zu einem einzelnen Rollo.

### Szenen

Der Datenpunkt `gateways.<gateway>.scenario` nimmt einen dieser Texte an:

| Wert | Bedeutung des VELUX-Szenarios | Signierung |
| --- | --- | --- |
| `bedtime` | Gute Nacht | nein |
| `wake_up` | Guten Morgen | nein |
| `away` | Abwesenheit / Gateway verriegeln | nein |
| `home` | Zuhause / Gateway entriegeln | ja |
| `start_airing` | Lüften starten | ja |
| `stop_airing` | Lüftszenario beenden | nein |

Die konkrete Wirkung einer Szene hängt von den am Gateway eingerichteten Produkten und Einstellungen ab. `stop_airing` ist ein Szenariobefehl und kein Ersatz für `stop_movements`. `locked` zeigt den vom Gateway gemeldeten Verriegelungszustand an.

### Zeitpläne

Zeitpläne liegen unter `homes.<home>.schedules`. Ein vorhandener Plan besitzt `definition`, `active`, `activate`, `rename`, `update` und `delete`. Über `schedules.create` kann eine neue Definition geschrieben werden. Die unterstützten Operationen benutzen die Cloudendpunkte `createnewhomeschedule`, `synchomeschedule`, `renamehomeschedule`, `deletehomeschedule` und `switchhomeschedule`.

`create` und `update` erwarten einen JSON-Text mit dem VELUX-Schema. Für neue Pläne sind `name`, `schedule_type` (`event` oder `algo`), `zones` und `timetable` erforderlich. Ein Update ergänzt fehlende Felder aus der zuletzt eingelesenen Definition. Der Adapter überprüft die Grundstruktur, implementiert aber keinen vollständigen visuellen Zeitplaneditor und interpretiert nicht alle internen Zonenregeln.

Als Ausgangspunkt eine bereits mit der VELUX-App angelegte `definition` verwenden. Die Strukturen von `zones` und `timetable` sind keine frei formulierten Zeiten oder Cronausdrücke. Einen laufenden Plan erst löschen, wenn seine Kennung geprüft wurde; `delete = true` ist ein echter Cloud-Löschbefehl.

## Bekannte Grenzen

- **Hardwaretests stehen aus.** Die Tests belegen unter anderem JSON-Aufbau, Grenzen, Routing, Signierung und Fehlerbehandlung im simulierten Ablauf. Sie belegen keine erfolgreiche reale Fensterfahrt.
- **Cloudabhängigkeit bleibt bestehen.** Der lokale TCP-Kanal wird für die Kopplung verwendet. Eine vollständige lokale beziehungsweise offline nutzbare Motorsteuerung ist nicht nachgewiesen und wird nicht angeboten.
- **Gateway-Stopp wirkt gatewayweit.** Seine Reaktionszeit hängt von Cloud, Verbindung und Gateway ab. Er ist keine garantierte unmittelbare Notabschaltung.
- **Gerätefähigkeiten unterscheiden sich.** Silent, Lamellen, Sensorwerte und konfigurierbare NXS-Steuerbereiche werden nur bei passenden Produkt- und Statusinformationen angeboten. Fehlende Felder werden nicht als vorhandene Hardwarefunktion ausgegeben.
- **Regenschutz und Verriegelungen bleiben relevant.** Empfangene Statusdaten können verzögert sein. Aus `reachable`, einer Regenmeldung oder `force` lässt sich keine Freigabe für eine Fahrt ableiten.
- **Keine App-Komplettkopie.** Produktanlernen, sämtliche App-Einstellungen, lokale App-PIN-Entsperrung und ein grafischer Zeitplaneditor sind nicht enthalten. PIN-Kommandos für ein gekoppeltes Gateway werden ausschließlich über die dokumentierte Nachrichtenschnittstelle angeboten.
- **Keine automatische Migration.** Neue Objekt-IDs und Schreibbefehle unterscheiden sich bewusst von `ioBroker.velux`. Bereits vorhandene Automationen benötigen eine gezielte Anpassung.

## Fehler eingrenzen

| Beobachtung | Nächster sinnvoller Schritt |
| --- | --- |
| Keine Homes oder Anmeldung fehlgeschlagen | Kontodaten prüfen; einen bewusst hinterlegten Refresh-Token beziehungsweise eigenen OAuth-Client berücksichtigen. Instanzlog ohne Geheimnisse prüfen. |
| Rollo fährt, Dachfenster öffnet nicht | `pairing.keyAvailable`, Gateway-Zuordnung und Signaturverfahren prüfen. Geschützte Fensterbefehle benötigen den passenden Gateway-Schlüssel. |
| Kopplung schlägt fehl | Originale Gateway-ID, lokale IP, TCP `25050` und physische Bestätigung nach dem Blinksignal prüfen; `pairing.status` lesen. |
| `UNKNOWN_SIGNING_SCHEME` | Die gemeldete interne Firmware ist unbekannt oder nicht unterstützt. Nur ein für dieses Gateway geprüftes Verfahren manuell wählen. |
| Einzelstopp wird abgelehnt | Die Option ist standardmäßig aus. Den gatewayweiten `stopAll` entsprechend seinem Wirkungsbereich verwenden oder den Einzelstopp bewusst als Experiment aktivieren. |
| `silent` oder Lamellensteuerung fehlt | Prüfen, ob das konkrete Produkt die erforderlichen Statusfelder beziehungsweise Typ- und Firmwarebedingungen erfüllt. |
| Sollwert bestätigt, Motor noch unterwegs | Die tatsächliche `position`, `busy`, Zeitstempel und Befehlsergebnisse betrachten. Eine Cloudbestätigung ist keine Zielerreichung. |
| Live-Verbindung fehlt | Regelmäßiges Polling bleibt aktiv. Internetzugriff und Cloudverfügbarkeit prüfen. |
| Zeitplan wird abgewiesen | Eine vorhandene `definition` als Schema-Vorlage verwenden und Cloudfehler auswerten. Die gültige äußere JSON-Struktur allein garantiert keinen gültigen VELUX-Plan. |

## Entwicklung und Nachweise

```bash
npm install --ignore-scripts
npm test
npm run check
```

Die Tests verwenden `node:test` und simulierte Dienste. Sie benötigen keine Zugangsdaten und schicken keine Gerätebefehle. Die Syntaxprüfung untersucht die JavaScript-Dateien des Projekts. Die GitHub-CI führt dieselben Schritte unter Node.js 22 und 24 aus und veröffentlicht kein npm-Paket.

Das Projekt verwendet natives `fetch`, `WebSocket`, TCP und Node-Kryptografie. Die einzige direkte Laufzeitabhängigkeit ist `@iobroker/adapter-core`. Der geprüfte Paketstand ist 3.4.3; dessen Peer-Abhängigkeit ist der Grund für die Mindestanforderung js-controller 7.2.2. Siehe die [Paketdefinition von adapter-core](https://github.com/ioBroker/adapter-core/blob/master/package.json).

### Quellenbasis

| Quelle | Geprüfter Stand und Verwendung |
| --- | --- |
| Bereitgestellte Android-App **VELUX ACTIVE 3.4.0.0** | App-Versionskennung `791304000`. Statische Prüfung echter Payload-Builder für Gateway-Stopp, Szenen, Raumautomatik, Timer, Silent, Lamellen, Gruppen und Zeitpläne. Die APK und extrahierte App-Dateien werden nicht mitgeliefert. |
| [TA2k/ioBroker.velux](https://github.com/TA2k/ioBroker.velux/tree/c30722f1adb70d2622d695277ef40c66291e1fcb) | Commit `c30722f1adb70d2622d695277ef40c66291e1fcb`, Adapter 0.0.9. Vergleich mit bisherigem Routing und `target_position`-Schreibpfad. |
| [Niek/ha-velux-active](https://github.com/Niek/ha-velux-active/tree/1df8a2cfed070c40f81e453dff8c7a054459f9c0) | Commit `1df8a2cfed070c40f81e453dff8c7a054459f9c0`, Version 0.1.39. Referenz für Cloudanmeldung, Live-Ereignisse, lokale NetCom-Kopplung und Signierung. Übernommene beziehungsweise angepasste Teile sind in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) bezeichnet. |
| [ioBroker-Rollendokumentation](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/stateroles.md) | Bedeutung der Rollen und Positionsskala. |
| [ioBroker JSONConfig](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md) | Aufbau der Admin-Konfiguration und Geheimnisschutz. |

Die APK-Prüfung unterscheidet tatsächliche Schreibpfade von bloß gelesenen Statusfeldern. Beispielsweise wird `algo_disabled` als empfangener Modus behandelt, während die Raumautomatik mit `algo_available` beziehungsweise `manual` geschrieben wird. Eine ausführliche technische Zuordnung enthält [docs/protocol.md](docs/protocol.md).

## English overview

VELUX Extended is an independent ioBroker adapter for VELUX ACTIVE. It uses the VELUX/Netatmo cloud, supports a cloud event stream with polling fallback, and pairs locally with each gateway to obtain signing keys for protected commands. It requires Node.js 22.19.0+, js-controller 7.2.2+ and Admin 6+.

Positions use **0 = closed, 100 = open**. The proven `stopAll` command applies to every moving product connected to the selected gateway. Individual device stop uses the experimental `target_position: -1` command and is disabled by default. Silent operation and lamella orientation are capability-dependent. Pairing does not provide complete offline control.

Version 0.1.0 has automated protocol and integration tests; real hardware validation is pending. Install from this GitHub repository using the ioBroker URL installer. Refer to the [state model](docs/STATE_MODEL.md) and [protocol notes](docs/protocol.md) for exact commands and limitations. The Admin form includes English and German translations.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Hinweise zu verwendeten Fremdanteilen stehen in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). VELUX und Netatmo werden zur Beschreibung der kompatiblen Produkte genannt.

## Changelog

### 0.1.0

- Erster eigenständiger Adapter mit korrekter Home-/Gateway-Zuordnung und ausdrücklichen ioBroker-Steuerdatenpunkten.
- Gateway-Stopp, optionale experimentelle Einzelstopps, Raum- und Gruppenbefehle, Silent, Lamellen, Szenen und Schließtimer.
- Lokale Schlüsselkopplung, signierte Cloudbefehle, Live-Ereignisse, Zeitplanoperationen und strukturierte Diagnose.
- Deutsche und englische Admin-Konfiguration sowie automatische Tests. Hardwareprüfung steht aus.
