// Einstellungen für Rüdigers Gassi-App
// Nur diese Datei müsst ihr anpassen.

window.GASSI_CONFIG = {
  // Aus Supabase: URL unter "Connect" bzw. Project Settings > Data API,
  // Schlüssel unter Project Settings > API Keys: "Publishable key" (beginnt mit sb_publishable_)
  // oder der alte "anon public" Key. Niemals den Secret- bzw. service_role-Key eintragen.
  // Leer lassen = Testmodus, Daten bleiben nur auf dem jeweiligen Handy.
  SUPABASE_URL: "https://tuaffkmvurmjiirloupj.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_wWEiKC6nRNQTVTADTnnWEw_yzEERHTU",

  // Wer mit Rüdiger geht
  WALKERS: ["Christopher", "Kim"],

  // Die vier Runden.
  // "time" = übliche Startzeit, solange es noch keine eigenen Werte gibt.
  ROUNDS: [
    { name: "Morgens",      time: "07:00" },
    { name: "Mittags",      time: "12:30" },
    { name: "Abends",       time: "18:00" },
    { name: "Letzte Runde", time: "22:30" }
  ],

  // Dauer in Minuten für "Erledigt", solange es für eine Runde noch keinen Durchschnitt gibt.
  DEFAULT_MINUTES: 30,

  // Ein Gassi-Tag läuft von 4:00 bis 4:00 Uhr.
  // So zählt eine letzte Runde um 0:30 Uhr noch zum Vortag.
  DAY_START_HOUR: 4
};
