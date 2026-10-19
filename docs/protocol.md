# Protokoll, Signaturen und Gateway-Kopplung

Diese Implementierung verbindet die VELUX-Cloudsteuerung mit einer regulären lokalen Kopplung für Signaturschlüssel. Die Signaturformate wurden in der bereitgestellten Android-App **VELUX ACTIVE 3.4.0.0**, Paket `com.velux.active`, Versionscode `791304000`, nachvollzogen. Der lokale NetCom-Ablauf wurde zusätzlich mit der öffentlichen Implementierung von [Niek/ha-velux-active](https://github.com/Niek/ha-velux-active) abgeglichen. Der Stand wurde am 19. Oktober 2026 geprüft.

Die automatisierten Tests verwenden ausschließlich synthetische Schlüssel und einen simulierten Gateway. Ein Funktionstest dieser Node.js-Implementierung mit einem echten VELUX-Gateway steht aus. Vollständige lokale oder internetunabhängige Bewegungssteuerung ist durch diese Arbeit nicht belegt.

## 1. Aufgaben der beiden Verbindungen

| Verbindung | Zweck | Implementierungsumfang |
| --- | --- | --- |
| HTTPS zur VELUX-Cloud | Geräteabfrage, Bewegungs- und Szenenbefehle sowie Vorbereitung der Schlüsselkopplung | Cloud-Client und Befehlsaufbau des Adapters |
| WebSocket zur VELUX-Cloud | Schnellere Ereignisse und Zustandsänderungen | Ergänzt den REST-Abgleich; ein Ereignis ist keine garantierte Bestätigung jeder physischen Bewegung |
| Lokales TCP zum Gateway, standardmäßig Port `25050` | Einmalige Anforderung und Bestätigung eines neuen Signaturschlüssels | `lib/pairing.js` |

Die APK enthält lokale NetCom-Kommunikation und eine Erkennung von `_netcom._tcp.` beziehungsweise `_hap._tcp.`. Das Vorhandensein dieser Transportfunktionen beweist noch keinen vollständig reproduzierten lokalen Steuerpfad für Fenster, Rollos oder Szenen. Der Adapter gibt daher keine Offline-Steuerung vor.

Die in der App nachgewiesenen Cloud-Adressen sind `https://app.velux-active.com/syncapi/v1` und `wss://app.velux-active.com/ws/`. Die WebSocket-Anmeldung verwendet eine `Subscribe`-Nachricht mit OAuth-Zugriffstoken. Die Referenzen dazu sind unter Abschnitt 7 aufgeführt.

## 2. Reguläre Kopplung

Die Kopplung benötigt das zum ausgewählten Zuhause gehörende Gateway, einen berechtigten VELUX-Zugang, Erreichbarkeit seiner lokalen IP-Adresse oder seines Hostnamens sowie Zugriff auf seine physische Taste. Ein mit Gateway A gekoppelter Schlüssel darf nicht für Gateway B verwendet werden.

Die Protokollreihenfolge ist:

1. Die authentifizierte Cloudverbindung setzt `retrieve_key: true` am ausgewählten Gateway.
2. Auf das Blinksignal am Gateway warten.
3. Die physische Gateway-Taste betätigen.
4. Den lokalen Schlüsselabruf ausführen und seine erfolgreiche Challenge-Bestätigung abwarten.
5. Schlüssel, Schlüssel-ID und die zugehörigen Zuhause-/Gateway-IDs verschlüsselt speichern. In normalen Statusdaten nur das Ergebnis und die Verfügbarkeit des Schlüssels anzeigen.

Die Referenz beschreibt einen Tastendruck nach dem Blinksignal. Eine bestimmte Haltedauer wird nicht vorausgesetzt. Der Adapter darf eine fehlgeschlagene Cloudvorbereitung nicht als erfolgreiche Freigabe behandeln: Auch bei HTTP 200 können Fehler im Antwortkörper stehen.

Für den Cloudschritt lautet der Inhalt des `json`-Parameters an `setstate`:

```json
{
  "home": {
    "id": "HOME_ID",
    "modules": [
      {
        "id": "GATEWAY_ID",
        "retrieve_key": true
      }
    ]
  }
}
```

`pairGateway()` führt ausschließlich Schritt 4 aus. Der Adapter trennt die Schritte ausdrücklich: `pairing.start` bereitet den Abruf vor und setzt den Status auf `awaiting_button`. Nach dem physischen Tastendruck startet `pairing.confirm` den lokalen Abruf. `pairing.cancel` beendet die Vorbereitung beziehungsweise bricht einen laufenden Abruf ab. Für `sendTo('pairGateway', ...)` heißen diese Phasen `prepare`, `confirm` und `cancel`. Der Adapter lässt für die Bestätigung ein Zeitfenster von zwei Minuten zu; der anschließende lokale Abruf hat sein eigenes Gesamtlimit von 30 Sekunden. Die zwei Minuten sind ein Adapterlimit und keine aus der APK abgeleitete Gateway-Garantie.

```js
const { pairGateway } = require('../lib/pairing');

// Erst nach erfolgreichem retrieve_key und der physischen Bestätigung aufrufen.
const signingKey = await pairGateway({
    host: '192.0.2.10', // Platzhalter für die lokale Gateway-Adresse
    port: 25050,
    timeoutMs: 30000,
    signal: abortController.signal,
});
// signingKey hat sign_key_id und hash_sign_key. Nicht protokollieren.
```

Ein Verbindungsaufbau darf innerhalb des Gesamtzeitlimits wiederholt werden, solange noch keine Schlüsselanforderung gesendet wurde. Nach Beginn des Protokolls werden Schlüssel- oder Challenge-Fehler zurückgegeben. Die Bibliothek versucht nicht automatisch, weitere Schlüssel anzulegen. Dadurch werden bei einer unklaren Antwort keine wiederholten Schlüsselregistrierungen ausgelöst. Eine unterbrochene Kopplung kann trotzdem bereits einen Eintrag im Gateway erzeugt haben; die Bibliothek löscht keine Gateway-Schlüssel.

### NetCom-Nachrichten

Jeder Rahmen beginnt mit `uint16_le(type)` und `uint16_le(payload_length)`, gefolgt von genau dieser Anzahl Nutzbytes. Die vier Headerbytes zählen nicht zur Nutzdatenlänge. TCP kann Rahmen aufteilen oder mehrere gemeinsam liefern; der Decoder berücksichtigt beides und begrenzt Puffer und Warteschlange.

| Typ | Name | Nutzdaten im hier verwendeten Ablauf |
| --- | --- | --- |
| `0x0000` / `0x0001` | Ping / Pong | Leer |
| `0x0201` | ECDH-Anfrage | `0x01` und 32 Byte öffentlicher X25519-Schlüssel |
| `0x0202` | ECDH-Antwort | 32 Byte öffentlicher Schlüssel, optional vorangestelltes `0x00` oder `0x01` |
| `0x0200` | Verschlüsselter Rahmen | ChaCha20-Poly1305-Chiffretext und 16 Byte Authentifizierungstag |
| `0x020e` / `0x020f` | Schlüsselanfrage / Antwort | Anfrage: `0x00` und 16 Byte neue UUID; Erfolg: `0x00` und 32 Byte Signaturschlüssel |
| `0x020a` / `0x020b` | Nonce-Anfrage / Antwort | Anfrage: `0x00`; Antwort: nichtleere Gateway-Nonce |
| `0x020c` / `0x020d` | Challenge / Bestätigung | Anfrage: Schlüssel-ID und SHA-512-Digest; Bestätigung beginnt bei Erfolg mit `0x00` |
| `0x0008` | Ende | Leerer Rahmen, innerhalb des verschlüsselten Kanals |

Nach dem X25519-Austausch wird der 32-Byte-Sitzungsschlüssel aus den ersten 32 Bytes von `SHA512(shared_secret)` gebildet. Die Schlüssel-, Nonce-, Challenge- und Abschlussrahmen werden vollständig inklusive ihres inneren Headers verschlüsselt. Es gibt keine zusätzlichen authentifizierten Daten (AAD).

Senden und Empfangen haben getrennte 12-Byte-Nonces, die jeweils bei null beginnen. Die ersten vier Bytes bleiben null; die letzten acht Bytes bilden einen Zähler in Big-Endian-Reihenfolge. Nach jedem verschlüsselten Senden beziehungsweise erfolgreich authentifizierten Empfangen wird der zugehörige Zähler erhöht. Ein ungültiger Authentifizierungstag darf den Empfangszähler nicht erhöhen. Ein erschöpfter Zähler beendet die Sitzung.

Die Bestätigung des neuen Signaturschlüssels verwendet:

```text
challenge = SHA512(key_id_bytes || signing_key_bytes || gateway_nonce_bytes)
request_payload = key_id_bytes || challenge
```

Erst eine positive Gateway-Antwort gibt den Schlüssel an den Aufrufer zurück. Rückgaben sind URL-taugliches Base64 **mit Padding**. Die Schlüssel-ID hat 16 Byte, der Schlüssel 32 Byte.

### Zeitlimit und Fehler

`timeoutMs` ist ein Gesamtlimit einschließlich DNS/TCP-Verbindung, Wiederholungsabständen, Schlüsselaustausch, Schreibvorgängen und Challenge. Das TCP-Verbindungsfenster eines einzelnen Versuchs ist zusätzlich begrenzt. Ein `AbortSignal` beendet den Ablauf auch während eines Lese- oder Schreibvorgangs. Bei Abbruch und Fehler werden Socket und Sitzung geschlossen.

Wichtige Fehlercodes sind `PAIRING_TIMEOUT`, `ABORT_ERR`, `PAIRING_NETWORK_ERROR`, `PAIRING_PROTOCOL_ERROR`, `PAIRING_HANDSHAKE_FAILED`, `PAIRING_AUTHENTICATION_FAILED`, `PAIRING_KEY_ID_REJECTED`, `PAIRING_KEY_TABLE_FULL` und `PAIRING_CHALLENGE_REJECTED`. Meldungen enthalten keine Schlüssel, Rohpakete oder vom Aufrufer übergebenen Abbruchgründe.

## 3. Signierte Eigenschaften

`CommandSigner` signiert die Eigenschaften `target_position`, `scenario` und `pincode`. Die Rückgabe enthält die Signaturmetadaten; die ursprüngliche Eigenschaft wird vom Befehlsaufbau ergänzt.

| Eigenschaft | Zu signierender Wert | ID für HMAC |
| --- | --- | --- |
| `target_position` | Dezimaldarstellung der Zielposition, z. B. `50` | Geräte-ID des Fensters |
| `scenario` | Szenenname unverändert, z. B. `home` oder `start_airing` | Gateway-ID |
| `pincode` | Unveränderter String einschließlich führender Nullen | Gateway-ID |

Die Unterstützung von `-1` im Signaturformat beweist für sich allein keinen Einzelgerät-Stopp. Dieser Wert bleibt im Adapter eine gesondert schaltbare experimentelle Funktion. Der in der APK nachgewiesene Gateway-Befehl zum Stoppen lautet `stop_movements: "all"`; sein Geltungsbereich ist das ausgewählte Gateway.

Der Signer entscheidet weder über die Gerätekategorie noch über Berechtigungen oder die Bedeutung einer PIN. Er schaltet insbesondere keine Schutzfunktion um und setzt kein `force`. Die APK prüft vor geschützten Fensterbefehlen, ob Schlüssel vorhanden sind und der zugehörige Keystore freigegeben ist. Eine Kopplung dieses Adapters erzeugt dessen eigenen regulären Gateway-Schlüssel. Sie liest keine Schlüssel aus dem Android-Keystore und reproduziert keine Umgehung der App-PIN.

Der nachverfolgte `pincode`-Aufruf wird unter anderem von `com.velux.active.install.assistant.pin.ConfigurePin` im Einrichtungsablauf für einen Assistenten erzeugt. Das ist von der lokalen App-Keystore-Entsperrung zu unterscheiden: Das Setzen dieser Gateway-Eigenschaft entsperrt keinen Android-Keystore.

Für die PIN-Eingabe ist in der APK ein konfigurierbares Bedienelement mit vier Stellen als Standardwert sichtbar. Daraus wird keine allgemeine API-Regel von beispielsweise vier bis acht Stellen abgeleitet. Der Signer erhält die PIN als String und bewahrt den Wert unverändert; der umgebende Adapter entscheidet über das angebotene Einstellverfahren.

## 4. Die beiden Signaturformate

`scheme: 'hmac'` und `scheme: 'sha512'` sind explizite Werte des Signers. `auto` gehört ausschließlich zum Befehlsaufbau des Adapters. In der APK wählt `Gateway.W()` ab interner Firmware-Revision 60 HMAC; `Gateway.g0()` markiert die signierfähige Generation ab Revision 27. Der Adapter verwendet dafür die gemeldete interne Revision `firmware_revision_netatmo`, nicht eine beliebige sichtbare Versionszeichenfolge.

Bei fehlender oder nicht zuordenbarer Revision darf die Software kein Signaturformat raten. Unbekannte Schemanamen führen im Signer zu `UnsupportedFirmwareError` mit Code `UNSUPPORTED_FIRMWARE`. Revisionen unter 27 werden im automatischen Befehlsaufbau nicht als abgesicherter Steuerpfad angeboten. Zwar überspringt die APK in einem inneren Zweig dann die Signaturbildung, der äußere Fensterablauf enthält aber weiterhin Schlüsselprüfungen. Das genügt nicht als Nachweis für die zuverlässige Unterstützung dieser alten Gerätegeneration.

### HMAC, neuere Firmware

```text
message = UTF8(property + value + timestamp_decimal + nonce_decimal + module_id)
hash_property = Base64URL_with_padding(HMAC_SHA512(raw_signing_key, message))
```

Es werden **keine Trennzeichen** eingefügt. Die Nonce ist eine dezimale Ganzzahl. Zufällige Bytes oder ein zufälliger String wären ein anderes Format. Der Gateway-Schlüssel wird vor der Verwendung aus Base64 in seine Rohbytes dekodiert.

Rückgabefelder sind `hash_<property>`, `sign_key_id`, `timestamp` und `nonce`. Bei einem Befehl für ein Fenster wird dessen Modul-ID eingebunden; bei einer Gateway-Szene oder PIN dessen Gateway-ID.

### SHA-512, ältere signierfähige Firmware

Die ältere Variante ist unmittelbar aus `android.hu1.e()` rekonstruiert:

```text
message = UTF8(property + value) || raw_signing_key || UTF8(timestamp_decimal)
hash_property = Base64URL_with_padding(SHA512(message))
```

Die **rohen Schlüsselbytes stehen in der Mitte** der Nachricht. Diese Variante ist kein HMAC. Sie enthält keine Nonce und keine Modul-ID in der Hash-Nachricht. Rückgabefelder sind `hash_<property>`, `sign_key_id` und `timestamp`.

In beiden Varianten entspricht die Kodierung Androids Flags `URL_SAFE | NO_WRAP`. Das `=`-Padding bleibt erhalten. Eingabeschlüssel dürfen Standard-Base64 oder Base64URL mit oder ohne korrektes Padding verwenden; fehlerhafte Zeichen, Längen und nichtkanonische Kodierungen werden abgelehnt.

## 5. Zeit, Nonces und Neustarts

```js
const { CommandSigner } = require('../lib/signing');
const signer = new CommandSigner({ state: savedSigningCounters });
const metadata = signer.sign({
    property: 'target_position',
    value: 50,
    moduleId: windowId,
    signingKey,
    scheme: 'hmac',
});

// Vor der Übertragung dauerhaft speichern, auch wenn der Cloudaufruf scheitert.
await persistSigningCounters(signer.getState());
```

`timestamp` kann in ganzen Unix-Sekunden explizit übergeben werden. Ohne diesen Parameter nutzt der Signer die Systemzeit. Eine optionale Konstruktorfunktion `clock` liefert Millisekunden und dient unter anderem deterministischen Tests.

Die gespeicherten Zähler gehören zur Schlüssel-ID. Für HMAC gilt:

1. Bei einem neuen Schlüssel oder einer fortgeschrittenen Uhr beginnt die Nonce bei `0`.
2. Bei gleicher oder zurückgesprungener Uhr bleibt der letzte Timestamp erhalten, die Nonce steigt um eins.
3. Nach Nonce `32766` steigt der Timestamp um eine Sekunde und die Nonce beginnt wieder bei `0`. Dies entspricht dem Überlaufzweig in `android.hu1.b()`.

Für das alte SHA-512-Format steigt der Timestamp bei jedem weiteren Befehl mit demselben Schlüssel mindestens um eine Sekunde. Ein Schemawechsel setzt den Zeitstand nicht zurück. Die Systemzeit sollte korrekt synchronisiert sein: Die Zählerlogik vermeidet Wiederverwendung bei einem Rücksprung, ersetzt aber keine korrekte Zeitbasis gegenüber der Cloud.

`getState()` liefert eine abgetrennte, JSON-serialisierbare Struktur:

```json
{
  "version": 1,
  "keys": {
    "BASE64_KEY_ID": { "timestamp": 1700000000, "nonce": 3 }
  }
}
```

Die Struktur enthält keine Signaturschlüssel, PINs oder Befehlswerte. Ungültige persistierte Zähler führen zu einem Fehler; der Signer setzt sie nicht stillschweigend zurück. Signaturen müssen innerhalb einer Adapterinstanz sequenziell reserviert und die neuen Zähler vor dem Versand gespeichert werden. Schlägt das Speichern fehl, darf der Befehl nicht gesendet werden. Auch nach HTTP-Fehlern werden verbrauchte Zähler nicht zurückgesetzt.

Mehrere gleichzeitig steuernde Adapterinstanzen benötigen eigene gekoppelte Schlüssel oder eine gemeinsame atomare Zählerverwaltung. Getrennte Kopien derselben Zustandsdatei koordinieren ihre Nonces nicht. Schlüssel und Zähler sollten deshalb als zusammengehörige Zugangsdaten gesichert und wiederhergestellt werden.

## 6. Automatisierte Prüfung

`test/signing.test.js` prüft feste, unabhängig mit Python `hashlib`/`hmac` berechnete Referenzwerte für alle drei Eigenschaften und beide Schemata. Weitere Fälle decken Modulbindung, führende PIN-Nullen, Base64-Varianten, getrennte Schlüssel, Neustarts, Uhrenrücksprung, Nonce-Überlauf, beschädigten Zustand und unbekannte Schemata ab.

`test/pairing.test.js` prüft die X25519-Werte aus [RFC 7748, Abschnitt 6.1](https://www.rfc-editor.org/rfc/rfc7748#section-6.1), unabhängige ChaCha20-Poly1305-Referenzwerte und den vollständigen Austausch mit einem Gateway aus Speicherstreams. Der Mock implementiert Rahmen und Kryptografie eigenständig. Geprüft werden außerdem geteilte/zusammengefasste TCP-Rahmen, Ping während des Handshakes, öffentliche Schlüssel mit und ohne Präfix, falsche Authentifizierungstags, ungültige innere Rahmen, leere Nonces, abgelehnte Schlüssel und Challenges, volle Schlüsseltabellen sowie Timeouts und Abbruch während unterschiedlicher Phasen.

```sh
node --test test/signing.test.js test/pairing.test.js
```

In einer Umgebung, die Unterprozesse für den Test-Runner sperrt, kann auf den unterstützten Node-Versionen `--experimental-test-isolation=none` verwendet werden; auch das Paket-Testskript nutzt diesen Modus. Die Tests benötigen keine Gateway-Adresse, keine Cloud-Zugangsdaten und keinen Netzwerkzugriff.

## 7. Nachweise und Lizenz

Die folgenden APK-Stellen wurden statisch untersucht. Obfuskierte Namen gelten für die oben genannte APK-Version:

| Funktion | Nachweis in der APK |
| --- | --- |
| HMAC-Nachricht, Hash-Eigenschaft, Metadaten | `android.hu1.d()`, `com.netatmo.base.mapper.HashMapperKey`, Mapper `android.ip8` |
| Ältere SHA-512-Nachricht mit rohen Schlüsselbytes | `android.hu1.e()` |
| Zeit-/Nonce-Verwaltung | `android.hu1.b()` |
| URL-Base64 mit Padding | `android.hu1.a()`, Flags `10` |
| Firmwareauswahl und Fensterbefehle | `Gateway.W()`, `Gateway.g0()`, `android.xgd.g()`, `.h()`, `.j()` |
| Signierte PIN-Änderung | `android.er1.e()`, `.f()`, `com.velux.active.install.assistant.pin.ConfigurePin.D0()` |
| PIN-Länge als UI-Standard | `com.netatmo.basekeystore.ui.pinlockview.PinLockView.W1()` |
| Lokale Schlüsselanforderung | `android.yw5.D0()`, `.l1()`, `EndToEndKeyRequestFrame` |
| Nonce und Schlüssel-Challenge | `android.nq1.D0()`, `.q1()`, `.o1()` |
| Speicherung bestätigter Schlüssel | `android.aee.D0()`, regulärer Keystore-Ablauf |
| Lokale Diensterkennung | `android.or9.h()`, `.O()` |
| Cloud-WebSocket und Anmeldung | `android.mqg.s()`, `.t()`, `mqg$c`, `android.uqg` |
| Ereignisverarbeitung | `t0g.a()` → `o9b.b()` → `r9b.e()`, `fq7.d0()`, `fm4.a()`, `cm4.a()`, `dm4` |

Öffentliche ergänzende Quellen:

- [NetCom-Kopplung in Niek/ha-velux-active](https://github.com/Niek/ha-velux-active/blob/main/custom_components/velux_active/pairing.py)
- [HMAC-Signierung in Niek/ha-velux-active](https://github.com/Niek/ha-velux-active/blob/main/custom_components/velux_active/signing.py)
- [Kopplungsreihenfolge und Voraussetzungen](https://github.com/Niek/ha-velux-active#gateway-pairing)
- [Konfigurationsablauf der Referenzintegration](https://github.com/Niek/ha-velux-active/blob/main/custom_components/velux_active/config_flow.py)
- [MIT-Lizenz der Referenzintegration](https://github.com/Niek/ha-velux-active/blob/main/LICENSE)

Die NetCom- und Signaturimplementierung ist von dieser Referenzarbeit beeinflusst und teilweise adaptiert. Deren Copyright lautet **Copyright (c) 2026 Niek van der Maas**. Die vollständige MIT-Lizenz ist in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) enthalten. Der über den GitHub-Connector geprüfte Lizenzblob hat SHA `0dd7536b98a0a3ce20fb5fc07d65c84e3b894085`.
