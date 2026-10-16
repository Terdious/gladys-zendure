# Zendure für Gladys Assistant

Verbinde deine Solarbatterien **Zendure SolarFlow / Hyper** mit Gladys
Assistant. Die Integration liest die Telemetrie (Batteriestand, Lade- und
Entladeleistung, Ausgangsleistung ins Haus und Solarproduktion) aus der
Zendure-Cloud und — optional — direkt vom **lokalen MQTT-Broker** jedes Geräts,
für schnelle, auch ohne Internet stabile Updates mit automatischem Rückfall auf
die Cloud. Die Werte sind nur lesbar.

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
Batterie auf keiner Quelle mehr meldet oder wieder meldet (lokaler MQTT-Modus).
Seine Variablen liefern den Namen der Batterie, den neuen Zustand und die
Telemetriequelle.

## Ein Cloud-Verbraucher pro Zendure-Konto

Zendure erlaubt **nur einen Cloud-Verbraucher pro Konto** gleichzeitig. Nutzt
eine andere Anwendung die Cloud-Verbindung desselben Kontos (Home Assistant,
eine zweite Gladys-Instanz …), streiten sich beide um die Verbindung und die
Telemetrie wird lückenhaft. Nutze für jeden weiteren Verbraucher besser das
**lokale MQTT** — der lokale Broker kennt diese Grenze nicht. Die Integration
warnt einmal in ihren Protokollen, wenn sie dieses gegenseitige Verdrängen
erkennt.

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
