# Piepmanns: Einrichtung

Die App hieß früher "Rüdigers Runden". Die Adresse bleibt https://vumas169.github.io/ruediger/.

Aufwand: einmalig ca. 30 Minuten. Kosten: keine (kostenlose Tarife von Supabase und GitHub).

## Inhalt des Ordners

| Datei | Zweck |
|---|---|
| index.html | Die App-Oberfläche |
| styles.css | Design |
| app.js | Logik: Runden, Zeiten, Statistik, Abgleich |
| config.js | Eure Einstellungen (Datenbank, Namen, Runden) |
| setup.sql | Legt die Datenbank-Tabellen an (Neuinstallation) |
| update-2.sql | Einmaliges Update für Pause und Termine |
| manifest.webmanifest, sw.js | Machen die Webseite zur installierbaren App, auch offline |
| icons/ | App-Symbol |
| lib/supabase.js | Bibliothek für die Datenbank (nicht ändern) |

## Installation Schritt für Schritt

Am besten am Computer erledigen. Dauer etwa 30 Minuten.

### Teil A: Datenbank bei Supabase

1. supabase.com öffnen, "Start your project", Konto anlegen (geht auch mit GitHub-Login).
2. "New project": Name z. B. ruediger, Datenbank-Passwort über "Generate a password" erzeugen und sicher ablegen, Region "Central EU (Frankfurt)". "Create new project" klicken und 1 bis 2 Minuten warten.
3. Links "SQL Editor" öffnen, "New query". Den kompletten Inhalt von setup.sql einfügen und "Run" klicken. Erwartet: "Success. No rows returned".
4. Links "Authentication" > "Users" > "Add user" > "Create new user". E-Mail und Passwort für dich eintragen, Haken bei "Auto Confirm User", "Create user". Dasselbe für Kim.
5. "Authentication" > "Sign In / Providers": "Allow new users to sign up" ausschalten und speichern. Wichtig, sonst kann sich jeder mit der App-Adresse ein Konto anlegen.
6. Oben auf "Connect" klicken (oder "Project Settings" > "Data API") und die Project URL kopieren, z. B. https://abcd1234.supabase.co.
7. "Project Settings" > "API Keys": den "Publishable key" kopieren (beginnt mit sb_publishable_). Den Secret Key nicht verwenden.

### Teil B: App bei GitHub hochladen

1. github.com öffnen und kostenloses Konto anlegen. Der Benutzername wird Teil der App-Adresse.
2. Oben rechts "+" > "New repository". Name: ruediger, Sichtbarkeit "Public", "Create repository".
3. Auf der leeren Seite auf "uploading an existing file" klicken.
4. Die ZIP-Datei auf dem Computer entpacken, den Ordner gassi-app öffnen und seinen Inhalt (alle Dateien plus die Ordner icons und lib) in das Upload-Feld ziehen. Nicht den Ordner gassi-app selbst, sonst liegt index.html eine Ebene zu tief.
5. Unten "Commit changes".
6. In der Dateiliste config.js anklicken, oben rechts den Stift (Edit) wählen. SUPABASE_URL und SUPABASE_ANON_KEY zwischen den Anführungszeichen eintragen (beim Key den Publishable key). "Commit changes".
7. "Settings" > links "Pages". Unter "Build and deployment": Source "Deploy from a branch", Branch "main", Ordner "/ (root)", "Save".
8. Nach 1 bis 3 Minuten erscheint oben auf der Pages-Seite die Adresse: https://BENUTZERNAME.github.io/ruediger/

### Teil C: Am Computer testen

1. Die Adresse im Browser öffnen. Es erscheint die Anmeldung.
2. Mit deinem Konto anmelden. Unter dem Kreis sollte "Abgeglichen um ..." stehen, nicht "Testmodus".
3. Eine Runde mit "Erledigt" eintragen. In Supabase unter "Table Editor" > walks sollte die Zeile auftauchen. Danach wieder löschen (Runde antippen > Löschen).

### Teil D: Auf die Handys

iPhone:
1. Adresse in Safari öffnen.
2. Teilen-Symbol (Quadrat mit Pfeil) > "Zum Home-Bildschirm" > "Hinzufügen".
3. App über das neue Symbol starten und anmelden.

Android:
1. Adresse in Chrome öffnen.
2. Menü (drei Punkte) > "App installieren" bzw. "Zum Startbildschirm hinzufügen".
3. App über das neue Symbol starten und anmelden.

Danach auf jedem Handy unter "Optionen" einstellen, wer dort unterwegs ist. Die Anmeldung muss in der Homescreen-App erfolgen, eine Anmeldung im Browser zählt dort nicht.

### Wenn etwas nicht klappt

- Seite zeigt 404: noch 2 Minuten warten. Sonst prüfen, ob index.html direkt in der Dateiliste des Repositorys liegt.
- Weiterhin "Testmodus": config.js ist nicht ausgefüllt oder es fehlen Anführungszeichen.
- "Anmeldung hat nicht geklappt": Nutzer in Supabase prüfen, "Auto Confirm User" muss gesetzt gewesen sein.
- "Abgleich hat nicht geklappt": setup.sql wurde nicht vollständig ausgeführt oder der Key ist falsch. Unter "Optionen" steht die genaue Fehlermeldung.
- Supabase pausiert kostenlose Projekte nach etwa einer Woche ohne Nutzung. Bei täglicher Nutzung passiert das nicht. Falls doch: im Supabase-Dashboard "Restore project".

## Änderungen später

Geänderte Dateien bei GitHub hochladen (Add file > Upload files, gleichnamige Dateien werden ersetzt). Die Handys laden neue Versionen beim nächsten Öffnen automatisch. Ist die App gerade offen, erscheint oben "Neue Version verfügbar" mit dem Knopf "Aktualisieren". Unter Optionen steht die aktuelle Versionsnummer.

## So zählt die App

- Gezählt werden Runden und Minuten. Pausen zählen nicht zur Dauer.
- Der Gassi-Tag läuft von 4:00 bis 4:00 Uhr. Eine Runde um 0:30 Uhr zählt zum Vortag.
- Farben: Christopher gelb, Kim lila, zusammen blau.

## Bedienung

Heute
- ▶ startet die Zeitmessung, ⏸ pausiert, ▶ geht weiter, Stopp beendet.
- Erledigt trägt eine Runde mit einem Tipp ein (Dauer = Durchschnitt genau dieser Runde aus den letzten 30 Tagen, ohne Werte 30 Minuten).
- 👥 auf einer laufenden oder erledigten Runde: zusammen gegangen.
- 💩 während oder nach der Runde: jedes Antippen zählt ein Häufchen dazu. Korrigieren über die Runde.
- Fällige Termine von Rüdiger stehen oben, ✓ hakt sie ab.

Nachtragen und korrigieren
- Mit den Pfeilen oben zu einem früheren Tag gehen oder auf das Datum tippen und einen Tag wählen.
- Ø trägt die Runde mit der Durchschnittsdauer ein, Genau öffnet das Formular.
- Jede eingetragene Runde antippen, um Runde, Personen, Beginn, Dauer, Häufchen oder Notiz zu ändern oder sie zu löschen.

Termine
- "+ Termin": Art wählen (Zeckenschutz, Wurmkur, Kotprobe, Allergietablette, Impfungen, Tierarzt-Check, Krallen, eigener Termin). Abstand und Erinnerungen sind vorbelegt und änderbar.
- ✓ hakt einen Termin ab. Wiederkehrende Termine springen automatisch auf den nächsten Termin, gerechnet ab dem Tag des Abhakens.
- Erinnerungen erscheinen in der App (oben unter Heute und als Zahl am Reiter Termine). "In Kalender" legt den Termin mit den gewählten Erinnerungen im Handy-Kalender an. Dort klingeln die Erinnerungen auch, wenn die App zu ist.

## Benachrichtigungen

Einrichtung (einmalig):
1. update-3.sql im Supabase SQL Editor ausführen.
2. Supabase > Edge Functions > "Deploy a new function" > "Via Editor". Name: reminders. Inhalt von supabase/functions/reminders/index.ts einfügen, "Deploy".
3. In der Funktion unter "Details" bzw. "Settings" die Option "Enforce JWT verification" ausschalten und speichern.
4. In der App unter Optionen > Benachrichtigungen "Auf diesem Handy einschalten" und "Test senden".

Hinweise:
- iPhone: nur in der App vom Home-Bildschirm, ab iOS 16.4.
- Erinnerungen kommen zu den beim Termin eingestellten Zeitpunkten, bei Terminen ohne Uhrzeit um 8 Uhr. Für jeden gewählten Zeitpunkt (1 Woche, 3 Tage, 1 Tag vorher, am Tag) kommt eine eigene Benachrichtigung.
- Ausschalten pro Handy unter Optionen.
- Die Funktion verschickt Test- und "Neuer Termin"-Nachrichten nur für angemeldete Nutzer der App.

## Abkürzungen auf dem Startbildschirm

Echte Widgets sind für Web-Apps weder auf Android noch auf dem iPhone möglich. Auf Android zeigt langes Drücken auf das App-Symbol die Abkürzungen "Neuer Termin", "Kalender" und "Heute". Sie lassen sich auch als eigenes Symbol auf den Startbildschirm ziehen. Nach dem Update kann es nötig sein, die App einmal neu zum Startbildschirm hinzuzufügen, damit Android die Abkürzungen übernimmt.

## Reiter

- Heute: oben Termine und Fälliges, dann die offenen Runden. Erledigte Runden sind zusammengeklappt, die Tagesbilanz mit Kreis steht unten.
- Kalender: gemeinsamer Kalender mit Monatsansicht (Wischen wechselt den Monat), Terminen für eine Person oder beide, eigenen Farben, Ort, Wiederholung mit Pause, frei wählbaren Erinnerungen, Feiertagen des gewählten Bundeslands und durchgehenden Balken für mehrtägige Termine.
- Statistik: Zeit draußen, Runden, letzte 7 Tage, wer welche Runde geht, Rekorde, Runden pro Tag, Vergleich, Ø Dauer je Runde.
- Rüdiger: Behandlungen wie Zeckenschutz, Wurmkur, Impfungen.
- Optionen: wer auf diesem Handy unterwegs ist, Benachrichtigungen, Bundesland für Feiertage, "So funktioniert die App" mit allen Erklärungen, Konto und Version.
