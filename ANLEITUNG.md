# Rüdigers Runden: Einrichtung

Aufwand: einmalig ca. 30 Minuten. Kosten: keine (kostenlose Tarife von Supabase und GitHub).

## Inhalt des Ordners

| Datei | Zweck |
|---|---|
| index.html | Die App-Oberfläche |
| styles.css | Design |
| app.js | Logik: Runden, Zeiten, Statistik, Abgleich |
| config.js | Eure Einstellungen (Datenbank, Namen, Runden) |
| setup.sql | Legt die Datenbank-Tabelle an |
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

Datei bei GitHub ersetzen. Damit die Handys die neue Version sicher laden, in sw.js die Zeile `const CACHE = "ruediger-v5";` hochzählen (v2, v3 ...).

## So zählt die App

- Es gibt keine Punkte. Gezählt werden Runden und Minuten.
- Der Gassi-Tag läuft von 4:00 bis 4:00 Uhr. Eine Runde um 0:30 Uhr zählt zum Vortag.

## Bedienung

Heute
- ▶ startet die Zeitmessung, Stopp beendet sie.
- Erledigt trägt eine Runde mit einem Tipp ein (Dauer = Durchschnitt genau dieser Runde aus den letzten 30 Tagen, ohne Werte 30 Minuten).
- 👥 auf einer laufenden oder erledigten Runde: zusammen gegangen. Standard ist immer nur die Person, die auf diesem Handy eingestellt ist.
- 💩 auf einer erledigten Runde: Rüdiger hat sein Häufchen gemacht.

Nachtragen
- Tag wählen (Datum oder Heute/Gestern/Vorgestern).
- Ø trägt die Runde mit der Durchschnittsdauer ein, Genau öffnet das Formular für Beginn, Dauer und wer dabei war.

Korrigieren
- Jede eingetragene Runde antippen (unter Heute, Nachtragen oder über Verlauf). Änderbar sind Runde, Personen, Beginn, Dauer, Häufchen und Notiz. Löschen geht dort auch.

Zählweise
- Einträge über Erledigt oder Ø sind mit "ca." markiert und fließen nicht in künftige Durchschnitte ein.
- Gemeinsame Runden zählen in der Statistik bei beiden Personen, in "Alle Runden" nur einmal.
- Uhrzeit bei Erledigt: Wer gerade zurück ist, bekommt jetzt als Ende. Sonst wird die übliche Startzeit der Runde genommen.

## Reiter

- Heute: die vier Runden des Tages, mit den Pfeilen oben auch frühere Tage.
- Nachtragen: vergessene Runden eintragen und korrigieren.
- Verlauf: Minuten der letzten 7 Tage nach Person, Kalender der letzten 4 Wochen. Tippen öffnet den Tag.
- Statistik: wer wie oft gegangen ist (3 Tage, 7 Tage, 30 Tage, gesamt), Ø Dauer je Runde.
- Optionen: wer auf diesem Handy unterwegs ist, Abgleich, Abmelden.
