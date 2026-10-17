# Zendure für Gladys Assistant

Verbinde deine Solarbatterien **Zendure SolarFlow / Hyper** mit Gladys
Assistant. Die Integration liest die Telemetrie (Batteriestand, Lade- und
Entladeleistung, Ausgangsleistung ins Haus und Solarproduktion) aus der
Zendure-Cloud und — optional — direkt vom **lokalen MQTT-Broker** jedes Geräts,
für schnelle, auch ohne Internet stabile Updates mit automatischem Rückfall auf
die Cloud. Die Werte sind nur lesbar.

Jede Batterie wird über ihre **lokale API** (zenSDK)
gelesen und gesteuert, wenn sie in deinem Netzwerk antwortet — so wie Home
Assistant es macht —, mit der Zendure-Cloud als automatischem Rückfall.

## Voraussetzungen

- Ein **Zendure-Konto**, bei dem deine Batterien bereits in der Zendure-App
  eingerichtet und online sind.
- Gladys Assistant **5.1 oder neuer**.

## Unterstützte Modelle

SolarFlow 800, SolarFlow 800 Pro, SolarFlow 1600, SolarFlow 2400,
SolarFlow 2400 AC, SolarFlow 2400 Pro und Hyper 2000 (experimentell — die
Zuordnung der Telemetrie muss noch von einem Tester aus der Community bestätigt
werden).

## Funktionen

Jede Batterie wird mit zehn nur lesbaren Funktionen angelegt, in den
Energiekategorien von Gladys (Energiediagramme, Verlauf, Dashboards):

| Funktion                     | Gladys-Kategorie         | Einheit |
| ---------------------------- | ------------------------ | ------- |
| Batteriestand                | Batteriespeicher         | %       |
| Ladeleistung                 | Batteriespeicher         | W       |
| Entladeleistung              | Batteriespeicher         | W       |
| Leistung zum Haus            | Hausausgangssensor       | W       |
| Solare Eingangsleistung      | Energieproduktionssensor | W       |
| Geladene Energie             | Batteriespeicher         | kWh     |
| Entladene Energie            | Batteriespeicher         | kWh     |
| Energie zum Haus             | Hausausgangssensor       | kWh     |
| Solarenergie                 | Energieproduktionssensor | kWh     |
| Verbleibende Batterieenergie | Batteriespeicher         | kWh     |

Zendure meldet nur Leistungen: Die vier **Energie**-Funktionen (kWh) berechnet
die Integration, indem sie jede Leistung über die Zeit aufsummiert. Es sind
kumulierte Zählerstände, gespeichert im Datenvolume der Integration, damit ein
Neustart sie nicht zurücksetzt; eine Funkstille von mehr als 5 Minuten (Batterie
offline, Broker getrennt) wird ausgelassen statt geschätzt. Gladys macht aus dem
Zählerstand **Solarenergie** seine Diagramme der Energieproduktion. Die
**verbleibende Energie** ist der Batteriestand mal der Kapazität der Packs, die
die Batterie meldet (AB1000, AB2000, AB3000, eingebaute Packs); sie bleibt leer,
bis die Batterie ihre Pack-Liste sendet.

Seit Version 1.3.0 ist der Batteriestand der eines **Batteriespeichers** und
nicht der Akku eines Geräts, der getauscht werden muss: Gladys zählt deine
Hausbatterie nicht mehr zu den Warnungen bei schwachem Akku. Eine mit einer
älteren Version angelegte Batterie behält ihre bisherigen Kategorien, bis du
die neue Definition übernimmst: Klicke im Tab **Entdecken** bei der Batterie
(markiert mit **Bereits hinzugefügt**) auf **Aktualisieren**. Die Funktionen
werden an Ort und Stelle aktualisiert, ihr Verlauf, deine Szenen und Dashboards
bleiben erhalten. Dasselbe **Aktualisieren** fügt einer vor Version 1.5.0
angelegten Batterie die Energie-Funktionen hinzu.

## Deinen Zendure-Cloud-Schlüssel erhalten

Die Integration meldet sich bei der Zendure-Cloud mit einem
**Autorisierungsschlüssel** an (einem Base64-Token), den du einmalig in der
Zendure-App erzeugst:

1. Öffne die **Zendure**-App und melde dich mit deinem Konto an.
2. Gehe in den Bereich Entwickler / Home-Assistant-Integration der App und
   erzeuge (oder kopiere) deinen **Autorisierungsschlüssel** (auch „HA-Schlüssel“
   genannt).
3. Kopiere diesen Schlüssel.

> Der Schlüssel ist ein an dein Zendure-Konto gebundenes Geheimnis: Halte ihn
> privat. Gladys speichert ihn verschlüsselt und schreibt ihn nie in die
> Protokolle.

## Konfiguration

1. Öffne den Tab **Konfiguration** der Integration in Gladys.
2. Füge deinen Schlüssel in **Zendure-Cloud-Autorisierungsschlüssel** ein.
3. Stelle das **Aktualisierungsintervall** (Sekunden) ein — wie oft die
   Telemetrie aufgefrischt wird, wenn keine Echtzeit-Updates eintreffen. Der
   Standardwert (30 s) passt.
4. (Optional) Aktiviere **Lokales MQTT aktivieren (zenSDK)** — siehe unten.
5. (Optional) Wähle die Sprache der **Namen der Funktionen** (standardmäßig
   Englisch): Sie gilt für die Batterien, die du ab jetzt anlegst.
6. Klicke auf **Konfiguration speichern**. Deine Batterien erscheinen im Tab
   **Entdecken** und können hinzugefügt werden.

### Lokale API (zenSDK, standardmäßig aktiv)

Die SolarFlow-Batterien (800, 800 Pro, 1600 AC+, 2400 AC, 2400 AC+, 2400 Pro
— alle unterstützten Modelle außer dem Hyper 2000) bieten eine kleine **HTTP-API in deinem
Heimnetz**, zenSDK genannt. Die offizielle Home-Assistant-Integration nutzt sie
für diese Modelle: weder MQTT noch die Cloud. Mit **Lokale API der Batterien
verwenden** (Standard) liest die Integration jede Batterie alle 5 Sekunden
darüber und sendet auch die Befehle der Szenen und Widgets darüber.

- **Voraussetzungen**: Batterie und Gladys-Host im **selben Netzwerk** (der
  Container muss die IP-Adresse der Batterie erreichen: kein isoliertes
  Gäste-WLAN und kein VLAN dazwischen) und eine aktuelle Firmware: aktualisiere
  die Batterie in der Zendure-App, wenn ihre lokale API nicht antwortet.
  Modellspezifische Schritte, falls es welche gibt, stehen im
  [Zendure-HA-Wiki](https://github.com/Zendure/Zendure-HA/wiki) (z. B. seine
  [Seite zum SolarFlow 800](https://github.com/Zendure/Zendure-HA/wiki/SolarFlow-800)).
- **Adresse**: Die Integration übernimmt die IP-Adresse der Batterie aus der
  Zendure-Cloud. Liefert die Cloud keine, versucht sie den mDNS-Namen der
  Batterie `zendure-<Modell>-<Seriennummer>.local`, der sich in einem
  Docker-Container selten auflösen lässt: Trage dann unter **Adressen der
  lokalen API** Paare `Seriennummer=IP-Adresse` ein, durch Kommas getrennt
  (z. B. `HOA1NAH4N123456=192.168.1.42`). Feste IP-Adressen für die Batterien
  im Router helfen.
- **Automatischer Rückfall**: Eine Batterie, die drei Anfragen in Folge
  verpasst, wechselt sofort auf ihren lokalen MQTT-Broker, falls aktiviert;
  auf die Zendure-Cloud wechselt sie erst nach 90 Sekunden ohne Antwort (ein
  kurzer WLAN-Aussetzer belegt die Cloud-Verbindung nicht), und sie kehrt
  zurück, sobald ihre lokale API wieder antwortet. Beim Start hat eine
  Batterie dieselben 90 Sekunden für ihre erste Antwort. Eine Batterie, die nie geantwortet hat, bleibt einfach bei der
  Cloud, ohne Warn-Abzeichen.
- **Die Cloud bleibt ungenutzt**: Antworten alle Batterien lokal, verbindet
  sich die Integration gar nicht mit dem Zendure-Cloud-Broker; Home Assistant
  (oder eine andere App) mit demselben Zendure-Konto behält die einzige
  Cloud-Verbindung des Kontos.

### Lokales MQTT (empfohlen, wenn du es nutzt)

Wenn du lokales MQTT in der Zendure-App aktivierst (Entwicklermodus), sendet
jedes Gerät seine Telemetrie an einen lokalen Broker in deinem Netzwerk. Mit
**Lokales MQTT aktivieren (zenSDK)** in Gladys liest die Integration von diesem
Broker:

- **Schneller**: Lokale Werte aktualisieren sich alle 1–3 s statt etwa alle
  30 s über die Cloud.
- **Robust**: Die Telemetrie läuft auch bei einem Ausfall der Zendure-Cloud
  oder des Internets weiter.
- **Automatischer Rückfall**: Verstummt ein Gerät am lokalen Broker, wechselt
  die Integration von selbst auf die Cloud und kehrt zu lokal zurück, sobald
  wieder lokale Nachrichten eintreffen — ohne dein Zutun.

## Transport-Abzeichen

Jedes Gerät zeigt ein Abzeichen, das angibt, **wie es gerade erreicht wird**:

- **Lokal** (grün) — über seinen lokalen MQTT-Broker (Normalfall bei
  aktiviertem lokalem MQTT).
- **Cloud** (blau) — über die Zendure-Cloud (Normalfall bei deaktiviertem
  lokalem MQTT).
- **Cloud + oranger Punkt (beeinträchtigt)** — das Gerät _sollte_ lokal sein,
  läuft aber vorübergehend über den Cloud-Rückfall (sein lokaler Broker ist
  verstummt). Fahre mit der Maus über das Abzeichen, um den Grund zu sehen. Das
  verschwindet von selbst, sobald das Gerät wieder lokal sendet.
- **Nicht erreichbar** (rot) — die Zendure-Cloud meldet das Gerät offline, oder
  es schweigt auf allen Quellen.

Mit der lokalen API bedeutet **Lokal**, dass die lokale API oder der lokale
Broker das Gerät bedient. Der Grund der Beeinträchtigung nennt die verstummte
lokale Quelle.

## Steuerung über Szenen

Gladys hat noch keine Sollwert-Funktion für Batterien: Die Batterien werden
über **Szenen** gesteuert (und über das Dashboard-Widget). Füge in einer Szene
eine Aktion der Kategorie **Integrationen** hinzu.

| Aktion                   | Wirkung                                            |
| ------------------------ | -------------------------------------------------- |
| **Ausgangslimit setzen** | Maximale Leistung, die ans Haus abgegeben wird (W) |
| **Ladelimit setzen**     | Maximale Leistung aus dem Netz, AC-Laden (W)       |
| **AC-Modus setzen**      | Aus dem Netz laden oder ans Haus entladen          |
| **Ladestände setzen**    | Ladeziel (70-100 %) und Entladegrenze (0-50 %)     |

Die Integration schützt die Batterie:

- ein Limit wird auf die Nennleistung der Batterie begrenzt (z. B. 800 W
  Ausgang bei einer SolarFlow 800 Pro);
- Leistungslimits werden im „Smart-Modus“ gesendet und im Speicher gehalten,
  statt in den Flash der Batterie geschrieben zu werden (häufige Änderungen
  würden ihn abnutzen);
- eine Einstellung kann sich höchstens alle 3 s (Leistungslimits) oder 30 s
  (AC-Modus, Ladestände) ändern: Eine Szene, die es früher versucht, schlägt
  mit der Wartezeit fehl;
- ein Wert, mit dem die Batterie bereits läuft, wird nicht erneut gesendet
  (die Aktionsausgabe **Befehl gesendet** ist dann falsch);
- die Ladestände werden abgelehnt, bis die Batterie ihre aktuellen gemeldet hat
  (ihre Skala unterscheidet sich je nach Firmware).

Der Befehl geht über den Broker, der die Batterie gerade bedient (lokal oder
Cloud); der neue Wert erscheint mit der nächsten Meldung der Batterie.

Der Auslöser **Erreichbarkeit einer Batterie** startet eine Szene, wenn eine
Batterie auf keiner Quelle mehr meldet oder wieder meldet (lokale API oder lokales MQTT).
Seine Variablen liefern den Namen der Batterie, den neuen Zustand und die
Telemetriequelle.

## Dashboard-Widgets

Im Dashboard-Editor stehen vier Widgets bereit (Gladys 5.1 oder neuer):

- **Zendure-Batterie**: eine Batterie, gewählt in den Widget-Einstellungen. Ihr
  Ladestand und ihre vier Leistungen folgen der Batterie live; darunter ihre
  Quelle (lokal, Cloud, Rückfall, nicht erreichbar), die gespeicherte Energie,
  Ausgangs- und Ladelimit, AC-Modus und die gemeldeten Ladestände. Die
  Schaltflächen **Leistungslimits** und **Modus & Stände** öffnen ein mit den
  aktuellen Werten vorausgefülltes Formular: Ändere, was nötig ist, und
  bestätige. Es gelten dieselben Schutzregeln wie bei den Szenenaktionen.
- **Batteriegruppe**: mehrere Batterien zusammengefasst unter einem Namen
  deiner Wahl: durchschnittlicher Ladestand (nach Pack-Kapazität gewichtet,
  wenn alle bekannt sind), Gesamtleistungen, gespeicherte Energie und eine
  Zeile pro Batterie, gefärbt nach ihrer Quelle. Lass die Batterieliste leer,
  um alle Batterien des Kontos zu nehmen.
- **Zendure-Anlage**: die ganze Installation auf einer Karte. Wähle die
  **Elektrische Anlage**: _Einphasig_ summiert die gewählten Batterien (keine:
  alle); _Dreiphasig_ nimmt die Batterien der Listen **Batterien der Phase
  L1**, **L2** und **L3**. Die Karte zeigt die Summen der Anlage (Ladestand
  nach Pack-Kapazität gewichtet, Laden, Entladen, Solar, Leistung zum Haus,
  gespeicherte Energie), dreiphasig dann eine Zeile pro Phase (`⌂` zum Haus,
  `↑` Laden, `↓` Entladen, `☀` Solar, in W) und die **Phasenbalance**: den
  Abstand zwischen der höchsten und der niedrigsten Leistung zum Haus, orange
  oberhalb der **Schieflast-Warnung** (standardmäßig 500 W). Darunter:
  gespeicherte Energie über der bekannten Kapazität, Restzeit bei der
  aktuellen Leistung, Anzahl der Batterien je Quelle (lokal, Cloud, nicht
  erreichbar) und Warnzeilen für nicht erreichbare Batterien, Cloud-Rückfälle
  und eine Batterie in zwei Phasen, in keiner oder gelöscht. Eine nicht
  erreichbare Batterie behält Ladestand und gespeicherte Energie, ihre letzten
  Leistungen fließen aber nicht in die Summen ein.
- **Energie heute**: die Energie des Tages seit lokaler Mitternacht, mit
  derselben Anlagenwahl und denselben Phasenlisten: geladen, entladen, Solar
  und zum Haus (kWh), dreiphasig eine Zeile pro Phase mit dem Abstand zwischen
  den Phasen, und ein Diagramm der Leistung zum Haus je 30 Minuten (eine Kurve
  pro Phase). Der Tag beginnt um Mitternacht der **Zeitzone** des Widgets
  (ein IANA-Name, standardmäßig `Europe/Paris`: Gladys gibt einer Integration
  seine Zeitzone nicht). Die Werte stammen aus den Energiezählern der
  Integration (unter `/data` gespeichert, mit einem Schnappschuss alle 30
  Minuten, 26 Stunden lang aufbewahrt): Sie zählen ab der ersten Meldung des
  Tages, die die Zeile **Gezählt seit** angibt (etwa nach einer ersten
  Installation am Morgen).

**Dreiphasiges Beispiel:** 17 Batterien auf L1, L2 und L3. Füge ein Widget
**Zendure-Anlage** hinzu, stelle **Elektrische Anlage** auf _Dreiphasig_ und
hake in **Batterien der Phase L1** die sechs an L1 angeschlossenen Batterien
an (etwa zwei 2400 AC, eine 2400 Pro, zwei 800 Pro und ein 800 ohne
Batterie), in **L2** die sechs von L2 und in **L3** die fünf von L3. Die Karte
zeigt die Summen der Anlage, pro Phase eine Zeile wie `L1 (6) · 60 %` —
`⌂ 1890 · ↑ 500 · ↓ 1000 · ☀ 1400 W` und `Phasenbalance` —
`Δ 1490 W · L1 am höchsten`, orange oberhalb der Schwelle. Füge ein Widget
**Energie heute** mit denselben drei Listen für die kWh des Tages hinzu. Eine
einphasige Installation behält die Standardeinstellung und lässt die Listen
leer. Das Widget **Batteriegruppe** bleibt für jede andere Gruppierung
verfügbar.

Jedes Widget zeigt nur, was die Batterie hat: Ein SolarFlow 800 ohne
Batteriepack behält Solar, Leistung zum Haus und Ausgangslimit (kein
Ladestand, keine Ladewerte und keine Schaltfläche **Modus & Stände**), und ein
AC-gekoppeltes Modell (1600 AC+, 2400 AC, 2400 AC+) hat keine Solar-Kachel.
Während die Batterie lädt oder entlädt, zeigt das Widget die verbleibende Zeit
bis zum Ladeziel oder zur Entladegrenze, wie die Batterie sie meldet (oder aus
ihrer Kapazität berechnet, wenn sie keine liefert). Eine Gruppe lässt
Batterien ohne Pack bei ihrem mittleren Ladestand und der gespeicherten
Energie außen vor, und eine Gruppe solcher Geräte zeigt nur ihre Leistungen.

## Ein Cloud-Verbraucher pro Zendure-Konto

Zendure erlaubt **nur einen Cloud-Verbraucher pro Konto** gleichzeitig. Nutzt
eine andere Anwendung die Cloud-Verbindung desselben Kontos (Home Assistant,
eine zweite Gladys-Instanz …), streiten sich beide um die Verbindung und die
Telemetrie wird lückenhaft. Nutze für jeden weiteren Verbraucher besser das
**lokale MQTT** — der lokale Broker kennt diese Grenze nicht. Die Integration
warnt einmal in ihren Protokollen, wenn sie dieses gegenseitige Verdrängen
erkennt.

Mit der **lokalen API** (Standard) verbindet sich die Integration nur dann mit
dem Zendure-Cloud-Broker, wenn eine Batterie ihn braucht, und trennt sich
5 Minuten, nachdem die letzte Batterie, die ihn brauchte, wieder auf einer
lokalen Quelle ist: Antworten
deine Batterien lokal, streiten Home Assistant und Gladys nicht mehr um die
Cloud-Verbindung.

## Die Integration aktualisieren

**Aus dem Katalog installiert** (der übliche Fall): Gladys prüft den Store
regelmäßig. Erscheint eine neue Version, zeigt die Integration das Abzeichen
**„Update verfügbar“** (auch neben **Integrationen** im Menü gezählt), und ihr
Tab **Überwachung** nennt die angebotene Version mit einem Link zu ihren
Versionshinweisen. Klicke auf **Aktualisieren**: Gladys lädt das neue Image
**und** übernimmt das neue Manifest — neue Konfigurationsfelder erscheinen von
selbst, es muss nichts erneut eingefügt werden. Deine Konfiguration und deine
Geräte bleiben erhalten.

Gladys kann bis zu etwa anderthalb Stunden brauchen, um eine neue Version zu
bemerken (Aktualisierung des Store-Index). **„Update erzwingen“** prüft sofort:
Es liest die zuletzt veröffentlichte Version und lädt ihr Image.

**Im Entwicklermodus installiert** (Manifest von Hand eingefügt): **„Update
erzwingen“** lädt nur das Image des installierten Tags erneut, und die
angezeigte Version sowie die Konfigurationsfelder stammen aus dem eingefügten
Manifest — füge das aktualisierte Manifest erneut ein, um neue Felder zu
übernehmen.

## Fehlerbehebung

- **Eine Batterie wird nicht erkannt.** Öffne den Tab **Protokolle**: Eine
  Zeile `Unsupported Zendure model skipped: productModel "..."` nennt die
  genaue Modellbezeichnung, die die Zendure-Cloud meldet. Eröffne damit ein
  Issue auf [gladys-zendure](https://github.com/Terdious/gladys-zendure/issues),
  damit das Modell ergänzt werden kann.
- **Ein Gerät zeigt keine Werte (oder ist langsamer als die anderen), während
  die übrigen funktionieren.** Prüfe sein Transport-Abzeichen. Ist es bei
  aktiviertem lokalem MQTT auf **Cloud (beeinträchtigt)** zurückgefallen, hat
  seine Firmware möglicherweise stillschweigend aufgehört, lokal zu senden.
  Schalte in der Zendure-App die **MQTT-Steuerung dieses Geräts AUS**, speichere
  und schalte sie wieder **EIN** — es sendet innerhalb einer Minute wieder. Die
  Integration läuft in der Zwischenzeit über die Cloud und kehrt automatisch zu
  lokal zurück.
- **`Too Many Requests` in den Protokollen.** Die Integration taktet ihre
  Updates unter der Anfragegrenze des Gladys-Kerns und bremst sich bei Bedarf
  selbst; gelegentliche Spitzen sind harmlos. Eine dauerhafte Flut bedeutet
  meist, dass eine **zweite Instanz der Integration** (z. B. ein Produktions-
  und ein Testcontainer nebeneinander) dasselbe Budget des Kerns teilt —
  betreibe nur eine.
- **Direkt nach der Konfiguration bleibt alles still.** Prüfe, ob der
  Cloud-Schlüssel stimmt: Ein ungültiger oder abgelaufener Schlüssel zeigt auf
  dem Konfigurationsbildschirm den Status „Die Zendure-Cloud ist nicht
  erreichbar oder der Cloud-Schlüssel ist ungültig.“
- **Alle Details.** Setze `LOG_LEVEL=debug` und lies die Protokolle der
  Integration in ihrem Tab **Protokolle** (oder mit `docker logs` auf dem Host).
  Jeder Wechsel der Telemetriequelle wird in einer Zeile `telemetry:`
  protokolliert.
- **Eine Batterie bleibt bei der Cloud, obwohl ihre lokale API funktionieren
  sollte.** Beim Start listen die Logs jede nicht antwortende Batterie mit der
  versuchten Adresse und dem Grund auf, z. B. `local http: Garage (dCLTD95V)
not answering at 192.168.1.42 (from the cloud): EHOSTUNREACH`. `ENOTFOUND`
  bei einem `.local`-Namen heißt, dass mDNS im Container nicht aufgelöst wird:
  Trage ihre Adresse unter **Adressen der lokalen API** ein. `EHOSTUNREACH`,
  `ECONNREFUSED` oder `no answer within 2 s` heißen, dass der Container die
  Batterie nicht erreicht (anderes Netz, VLAN, Firewall) oder ihre Firmware
  noch keine lokale API hat. Alle 5 Minuten fasst eine Zeile
  `telemetry(local http):` zusammen, welche Batterien antworten.

### Diagnose

Zwei rein lesende Schaltflächen im Tab **Konfiguration** der Integration
liefern das Gesamtbild auf Abruf, ohne dass du die Protokolle durchsuchen
musst. Keine schreibt in eine Batterie oder ändert ihren Transport.

- **Diagnose der Batterien**: ein Textbericht der Installation — die Version
  der Integration, die Konfiguration (nie der Cloud-Schlüssel), die API der
  Zendure-Cloud, jeder Broker (verbunden oder nicht, Neuverbindungen der
  letzten 5 Minuten, Cloud-Broker im Ruhezustand, weil jede Batterie lokal
  läuft, Warnungen bei Sitzungsübernahme), die Abfrage der lokalen API, dann
  ein Block pro Batterie: die Quelle, die sie bedient, und warum, das Alter
  ihrer letzten Daten pro Quelle, die Adresse ihrer lokalen API (aus den
  Optionen, der Cloud oder mDNS) und ihr Zustand, die Packs, der
  Solareingang, die gemeldeten Einstellungen (Limits, AC-Modus, Ladestände),
  die Restzeit und die Energiezähler. Wähle eine Batterie in der Liste
  **Batterie** (die in Gladys angelegten Batterien), um nur sie zu
  beschreiben; für eine nicht in Gladys angelegte Batterie gib ihren Namen
  oder ihre Seriennummer im Feld darunter ein.
- **Lokale API einer Batterie testen**: liest einmal, sofort, `GET
/properties/report` an der Adresse, die die Integration verwendet, und
  zeigt die Antwortzeit, die Herkunft der Adresse und alle Eigenschaften, die
  die Batterie liefert — oder den genauen Fehler mit einem Hinweis
  (`ENOTFOUND` bei einem `.local`-Namen: **Adressen der lokalen API**
  ausfüllen; `EHOSTUNREACH`, `ECONNREFUSED` oder eine Zeitüberschreitung:
  Netzwerk oder Firmware).

Standardmäßig werden Seriennummern gekürzt (`WOB1…0159`) und lokale Adressen
durch `<local-ip>` ersetzt: Füge den Bericht unverändert in ein
[GitHub-Issue](https://github.com/Terdious/gladys-zendure/issues) ein,
zwischen zwei Zeilen mit drei Backticks. **Seriennummern und lokale Adressen
anzeigen** zeigt sie vollständig, nur für deine eigenen Prüfungen: Diese
Fassung nicht öffentlich posten. Kein Bericht enthält jemals den
Cloud-Schlüssel oder ein Passwort. Beide Berichte werden auch maskiert in die
Protokolle der Integration geschrieben.
