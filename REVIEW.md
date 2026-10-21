# Review: Shooter-Modus (Stand 2026-10-21)

**Umfang:** Nach `CLAUDE.md` betrifft dieses Review nur den **Shooter** (`src/modes/stationary.ts`,
`src/modes/stationary/`, Level 11–15) und den gemeinsamen Code, soweit der Shooter ihn nutzt. Den
Runner habe ich bewusst nicht bewertet.

**Grundlage:** Bewertet wurde der aktuelle Working Tree auf `main`, also mit den noch nicht committeten
Änderungen (25 geänderte Dateien, rund 4.700 Zeilen Diff, dazu neue Dateien wie `scene.ts`, `models.ts`
und `gl.ts`). Am Code habe ich nichts geändert. Die eigenen Analyse-Skripte liegen außerhalb des Repos.

---

## 1. Gesamteindruck

Technisch ist das ein solides MVP mit einer guten Architektur. Spielerisch gibt es derzeit aber ein
ernstes Problem mit dem Einstieg und der Schwierigkeitskurve.

**Was gut ist:**

- Die Simulation ist sauber vom Rendering getrennt: `StationarySim` läuft headless und deterministisch
  per Seed und speichert ihre Daten in Typed Arrays. Dieselbe Simulation nutzen Spiel, Tests und Bot.
  Das ist die beste Entscheidung im Projekt.
- Die Kernidee hat echte Spannung: Links liegt die Upgrade-Spur, rechts die Monster-Spur, und jede
  Sekunde links kostet einen Biss rechts. Die sichtbare Power-up-Kette ist ein guter Haken, weil man
  sieht, worauf man hinarbeitet.
- Die Präsentation ist ordentlich: 3D mit Instancing, Partikel, Kamera-Shake, Popups und
  synthetisierter Sound ohne Asset-Lizenzprobleme.
- Die Qualitäts-Infrastruktur ist besser als bei den meisten Hobby-Projekten: strikter Typecheck,
  ESLint, Prettier, 104 Tests, Level-Validator und CI-Deploy.

**Was das Spiel heute ausbremst:**

1. **Die Einstiegserfahrung frustriert.** Man startet mit einem einzigen Soldaten, und schon ein Biss
   beendet den Run. Ich habe Level 1 zweimal nach etwa 8 Sekunden verloren (Simulationszeit `t=10.6`,
   `GAME_SPEED` 1.3), beim ersten Mal mit **0 Münzen**. Auf dem Screen stand
   „Damage: 0% to the next level“. Dass man beim ersten Versuch verliert, ist Absicht: README und Test
   verlangen es (`tests/levels.test.ts:68`, `expect(first.winRate).toBe(0)`).
2. **Die Kurve endet in einer Wand ohne Meta-Fortschritt.** Ab Level 4 sind alle Upgrades am Cap.
   Danach haben Münzen keinen Nutzen mehr, und die Level sind selbst für einen übermenschlichen Bot
   nur noch zu 15–55 % zu gewinnen.
3. **Der Sieg-Moment friert ein.** Beim Gewinnen spielt `referenceSurvivors()` synchron bis zu 36
   Bot-Runs auf dem Main-Thread durch. Im Browser habe ich einen Hänger von 850 ms gemessen.
4. **Das Quality-Gate ist rot.** `npm run validate:levels` schlägt fehl (Exit 1). Weil die CI diesen
   Schritt ausführt, würde ein Commit des aktuellen Stands das Deployment blockieren.

**Fazit:** Die Codebasis trägt mehr, als der Content gerade hergibt. Die wirksamsten Hebel sind im
Moment Balancing und Einstieg, nicht neue Features.

---

## 2. Bewertung nach Bereichen

### 2.1 Spielspaß und Game Feel: 5/10

**Stärken**

- Die Zwei-Spuren-Entscheidung (Blöcke zerschießen oder Monster abwehren) ist eine echte Entscheidung
  unter Zeitdruck.
- Minibosse mit telegrafierten Zonen (`EliteStats`, `aimVolley`) bringen Ausweich-Gameplay. Dass eine
  Salve garantiert eine Lücke lässt (`leavesRoom`), ist fair gedacht.
- Die Horde fließt um Elites herum (`resolveBodies`) und wirkt dadurch lebendig.

**Schwächen (belegt)**

| Befund                     | Beleg                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Der erste Run endet sofort | Start mit 1 Soldat (`startCount: 1` in allen 5 Leveln), Biss = 1 Soldat (`MONSTERS.grunt.bite`). Die erste Reihe beißt nach etwa 7–8 s Echtzeit, der Hinweis-Text liegt 5 s lang über der Spur (`game.ts`, `showHint(..., 5000)`). Selbst gespielt: zweimal verloren nach etwa 8 s.                                                                                                                 |
| Sieg-Hänger                | `game.ts` `finishLevel` → `referenceSurvivors` → `minimumTier(level, 3)` + `analyzeStationary(..., 3)`, alles synchron. Gemessen: **850 ms** längster Frame beim Übergang zu VICTORY (Level 1, MacBook, Chromium). In Node: 0,9 s (L1) bis 3,5 s (L5). Auf einem Mittelklasse-Handy dürfte das ein Mehrfaches sein (nicht gemessen).                                                                |
| Alle fünf Level sind Klone | Die Item-Reihenfolge ist in allen Leveln identisch (`+1, +1, +50% rate, +2, +1, Waffe/Rate, +1, +1, +1, +50% dmg, x2 …`). Die Monster-Wellen folgen demselben Muster, nur die Zahlen sind skaliert. Werte wie `"grow": 3.6000000000000005` sprechen für einen Generator, der nicht im Repo liegt. Kein Level hat eine eigene Idee (zum Beispiel `side: "right"`, enge Formationen, ein Tank-Level). |
| Unerreichbare Köder        | Die letzten Blöcke haben 20.000 (L1) bis 95.000 HP (L5) und sind im Run praktisch nicht zu knacken. Gleich auf dem ersten Screen sieht man „20K“ und „11.5K“, was abschreckt, statt zu motivieren.                                                                                                                                                                                                  |
| Lesbarkeit im Late Game    | Bei 40+ Schützen bilden Mündungsfeuer und Kugeln eine helle Wand. Ein großes weißes Mündungs-Rechteck verdeckt den Trupp (Screenshot Level 5, Trupp 30–60).                                                                                                                                                                                                                                         |
| Maus schlägt Touch         | Mit der Maus springt der Trupp sofort auf den Zeiger (`snapSquad = input.usesMouse`), mit dem Finger gleitet er relativ mit Höchstgeschwindigkeit. Für ein „mobile-first“-Spiel ist der Touch-Spieler damit im Nachteil.                                                                                                                                                                            |

### 2.2 Suchtfaktor und Retention (ohne Dark Patterns): 4/10

**Schwierigkeitskurve gemessen**

Die Bot-Gewinnrate habe ich pro Upgrade-Stufe gemessen (20 Seeds je Zelle, Projekt-Bot `runBot`). Er
springt sofort auf sein Ziel, zielt alle 33 ms neu und reagiert nach 25 % der Warnzeit, ist also
klar übermenschlich.

| Level           | Tier 0 | Tier 4 | Tier 6 | Tier 8 | Tier 10 (alles max) |
| --------------- | ------ | ------ | ------ | ------ | ------------------- |
| 1 First Blood   | 0 %    | 60 %   | 100 %  | 100 %  | 100 %               |
| 2 Heavy Crates  | 0 %    | 0 %    | 0 %    | 70 %   | 100 %               |
| 3 Growing Pains | 0 %    | 0 %    | 0 %    | 65 %   | 100 %               |
| 4 The Flood     | 0 %    | 0 %    | 0 %    | 0 %    | **55 %**            |
| 5 Big Boss      | 0 %    | 0 %    | 0 %    | 0 %    | **15 %**            |

Dasselbe habe ich mit einem **menschenähnlichen Bot** gemessen. Er hat dieselbe Logik, aber kein
Springen (er gleitet wie bei Touch), zielt nur alle 200 ms neu und reagiert erst nach 45 % der
Warnzeit. Das ist eine Heuristik, kein echter Spieler.

| Level           | Tier 8 | Tier 10 |
| --------------- | ------ | ------- |
| 1 First Blood   | 100 %  | 100 %   |
| 2 Heavy Crates  | 0 %    | 45 %    |
| 3 Growing Pains | 0 %    | 75 %    |
| 4 The Flood     | 0 %    | **0 %** |
| 5 Big Boss      | 0 %    | **0 %** |

**Kampagne mit gemeinsamer Wallet** (kauft immer das billigste Upgrade):

| Level | Projekt-Bot (`npm run simulate:campaign`) | Menschenähnlicher Bot                       |
| ----- | ----------------------------------------- | ------------------------------------------- |
| 1     | 17 Runs, etwa 13 min                      | 29 Runs, etwa 20 min                        |
| 2     | 8 Runs, etwa 11 min                       | 23 Runs, etwa 23 min                        |
| 3     | 3 Runs                                    | 1 Run (leichter als L2)                     |
| 4     | 16 Runs                                   | **nach 150 Runs (138 min) nicht geschafft** |
| 5     | 7 Runs                                    | entfällt (gesperrt)                         |

**Folgerungen**

- **Die ersten 13–20 Minuten bestehen nur aus Niederlagen.** Gegen die eigentliche Stärke des Genres
  („in 30 Sekunden drin, sofort ein Erfolgserlebnis“) ist das der größte Retention-Killer.
- **Die Kurve ist nicht monoton.** Level 3 ist mit dem Upgrade-Stand nach Level 2 fast geschenkt,
  Level 4 und 5 sind Wände.
- **Der Meta-Fortschritt stirbt genau an der härtesten Stelle.** Im menschenähnlichen Durchlauf ist
  in Level 4 ab Run 2 alles gemaxt, danach folgen 148 Runs ohne irgendetwas zu kaufen. Die
  „Next goal“-Leiste zeigt dann nur noch das Coin-Upgrade (Screenshot: „Coins is ready! Tap its
  card“). Münzen sind ab da wertlos.
- **Wiederholen lohnt sich nicht:** Ein geschafftes Level zahlt nur 50 % (`REPLAY_PAYOUT`), und Sterne
  vergleichen mit einer Bot-Referenz. In Level 5 ist diese Referenz bei Tier 6 gleich 0, damit gibt
  `starsFor(x, 0)` **immer 3 Sterne**.
- **Dark Patterns:** Echte gibt es keine (keine Werbung, keine Energie, keine Timer, keine
  Käufe), das ist gut. Grenzwertig ist, dass das Design die F2P-Psychologie bewusst nachbaut:
  `COIN_SCALE = 20` („so it only feels richer“), „a near miss makes the next run tempting“
  (`ui.ts` `showGoal`), und der verlorene erste Versuch ist per Test erzwungen. Ohne Monetarisierung
  schadet das niemandem direkt, aber es ersetzt gutes Level-Design durch Grind. Mit Fortschritt per
  Können wäre das Spiel ehrlicher und motivierender.
- **Es fehlt:** Feedback bei Niederlage („62 % geschafft, Rekord 70 %“), Bestwerte pro Level, und für
  die Zeit nach dem Durchspielen ein Endlos- oder Tages-Seed-Modus.

### 2.3 UX, vor allem mobil: 6/10

**Gut**

- Relativer Drag mit sinnvoller Übersetzung: 100 px Fingerweg ergeben 4,2 Welteinheiten, das ganze
  Feld braucht etwa 290 px. Gemessen mit synthetischen Touch-`PointerEvent`s im 375×812-Viewport.
- `touch-action: none`, `safe-area-inset`, DPR auf 2 begrenzt, `prefers-reduced-motion` wird
  berücksichtigt.
- Kaufen und Retry liegen auf demselben Screen, das spart Taps.

**Probleme**

| Befund                                                                                      | Beleg                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Der Hinweis verdeckt Spur und Feld, während die erste Welle anrollt                         | Screenshot Level 1 (Hinweis-Box über der oberen Feldhälfte, 5 s lang)                                                                                                                                                                                                                 |
| Das X oben links beendet den Run ohne Nachfrage, und **die Münzen des Runs gehen verloren** | `game.ts` `toMenu()` verwirft den Mode ohne `coinsEarned`. Das widerspricht dem README („coins are kept even when a run is lost“).                                                                                                                                                    |
| Keine Pause, kein `visibilitychange`                                                        | Nach einem App-Wechsel läuft das Spiel sofort mitten in der Horde weiter. `grep visibilitychange` findet nichts.                                                                                                                                                                      |
| Querformat                                                                                  | Die Spalte wird winzig (Screenshot bei 812×375), ein Hinweis zum Drehen fehlt.                                                                                                                                                                                                        |
| Shop vor dem ersten Spiel                                                                   | Auf der Level-Auswahl stehen bei 0 Münzen vier deaktivierte Karten über den Leveln. Für Neulinge ist das Rauschen.                                                                                                                                                                    |
| Niederlage ohne Kontext                                                                     | „DEFEATED / Tap a card to upgrade“, aber nicht, wie weit man kam oder woran man starb.                                                                                                                                                                                                |
| Barrierefreiheit                                                                            | `user-scalable=no`, Spielinformationen nur im Canvas, nur Farbe signalisiert Gefahrenzonen.                                                                                                                                                                                           |
| Kein WebGL-Fallback                                                                         | Laut Code baut schon das Menü eine `ShooterScene` (Attract-Demo). Ohne WebGL wirft `WebGLRenderer` im Konstruktor, und vermutlich ist dann das ganze Spiel tot, Runner eingeschlossen. Auch `webglcontextlost` wird nicht behandelt. **Nicht getestet**, nur aus dem Code abgeleitet. |

### 2.4 Technische Umsetzung und Architektur: 7/10

**Stark**

- Headless-Simulation, Bot, Validator und Tests greifen ineinander (`CONTRIBUTING.md` nennt `sim.ts`
  zu Recht als Referenz).
- Kollisionen per Slab-Buckets mit Counting Sort, Ringpuffer für Kugeln, `InstancedMesh` pro Typ:
  durchdacht. Auf dem Mac liefen bis zu etwa 50 lebende Monster und 40 Schützen konstant mit 60 FPS.
- Spielstände werden migriert (`coinScale`), `localStorage` ist abgesichert, und es gibt Tests dafür.

**Schwächen**

| Befund                                             | Beleg                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Die beiden Quality-Gates widersprechen sich**    | `validate:levels` verlangt 60 % Bot-Siege bei Tier 10 mit 5 Seeds (`minimumTier`), der Unit-Test nur 10 % (`tests/levels.test.ts`). Ergebnis: Die Tests sind grün, Validate ist rot (`FAIL 14-flood.json`, `FAIL 15-big-boss.json`, Exit 1), CI und Deploy würden scheitern. |
| Validator-Statistik zu dünn                        | 5 Seeds bei einer Schwelle von 60 %: Laut Validator gewinnt der Bot L1 bei Tier 4 zu 80 %, mit 20 Seeds gemessen sind es 60 %. Das Ergebnis kippt leicht.                                                                                                                    |
| Balance an einem übermenschlichen Bot ausgerichtet | `bot.ts`: `snapSquad = true`, `AIM_EVERY = 1`, `REACTION = 0.25`. Der Kommentar in `simulate-campaign.ts` sagt „a person needs fewer runs“, das README sagt „about half as many runs“. Beides ist unlogisch, wenn der Bot besser spielt als ein Mensch.                      |
| Teure Sternberechnung zur Laufzeit                 | siehe 2.1 (850 ms). Die Werte sind deterministisch und könnten zur Build-Zeit berechnet werden.                                                                                                                                                                              |
| Falsche Kampagnen-Metrik                           | `simulate-campaign.ts` meldet für Big Boss „0 runs max without a purchase“. Tatsächlich wurde in 7 Runs nichts gekauft, weil alles gemaxt war. `dry` wird nur beim Kauf aktualisiert.                                                                                        |
| Unterschiedliche Zeitschritte                      | Der Bot rechnet fest mit 1/30 s, das Spiel mit Frame-dt (bei 60 Hz meist 1/60). Balancing und echtes Spiel laufen also leicht unterschiedlich. Das ist klein, aber unnötig: ein Fixed-Step-Accumulator in `Loop` würde es beheben.                                           |
| Allokationen pro Frame im Hot Path                 | `resolveBodies` (`elites: number[] = []`), `updateElite` (`caught`), `attacks.push({...})`, im Bot `filter/flatMap`. Das widerspricht der Regel in `CONTRIBUTING.md`, ist aber unkritisch.                                                                                   |
| Bundle                                             | 660 kB JS (170 kB gzip) in einem Chunk inklusive Three.js. Vite warnt beim Build. Der Shooter ließe sich per `import()` nachladen.                                                                                                                                           |
| Level-JSON ohne Quelle                             | 444–917 Zeilen je Level, offensichtlich generiert, ohne Generator im Repo. Von Hand lässt sich so ein Level nicht sinnvoll pflegen.                                                                                                                                          |
| Kleinkram                                          | `setPointerCapture` ohne `try` (`input.ts:43`). Gemischte Minus-Schreibweise (`'−'` neben `'−'`) in `stationary.ts`.                                                                                                                                                         |
| Commit-Hygiene                                     | Ein Working Tree mit 4.700 Zeilen Diff, der noch nicht committet ist, ist ein Risiko. Kleine, grüne Commits wären besser.                                                                                                                                                    |

### 2.5 Open-Source-Reife: 6/10

**Vorhanden:** MIT-`LICENSE`, `CONTRIBUTING.md`, `CREDITS.md`, CI mit Lint, Format, Validierung,
Tests und Build, ein dokumentiertes Level-Format und `?unlock=all` und `?debug` für Mitwirkende.

**Es fehlt:**

- Screenshots oder GIF und ein Live-Demo-Link im README („Screenshots: coming soon“). Das ist für ein
  Spiel der wichtigste Punkt auf der Repo-Seite.
- Ein roter `main`-Stand: Wer heute forkt und `npm run validate:levels` laufen lässt, sieht einen
  Fehler.
- Issue- und PR-Templates, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `engines` in `package.json` (das
  README sagt Node 20+, die CI nutzt 22).
- `CONTRIBUTING.md` spricht von „winnable by a perfect player“, für Shooter-Level ist das aber ein Bot
  mit 60 %-Schwelle. Ein Shooter-Level per Hand beizutragen, ist mit 900 Zeilen JSON realistisch nicht
  machbar.
- Das README ist eher Design-Dokument als Einstieg. Die Shooter-Mechanik-Beschreibung gehört eher in
  `docs/`.

---

## 3. Top 10: wirkungsvollste Verbesserungen (Nutzen im Verhältnis zum Aufwand)

Aufwand: **S** unter einem halben Tag, **M** 1–2 Tage, **L** mehr als 2 Tage.

| #   | Maßnahme                                                                                                                                                                                                              | Nutzen      | Aufwand | Warum                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ersten Run gewinnbar machen**: L1 mit 3–5 Soldaten oder einer langsamen, schmalen ersten Welle (`delay`, `spread`), erste Welle erst nach dem Hinweis. Den Test `expect(first.winRate).toBe(0)` für L1 umdrehen.    | sehr hoch   | S       | Die erste Minute entscheidet, ob jemand bleibt. Heute heißt sie: 8 s, DEFEATED, 0 Münzen.                           |
| 2   | **Sieg-Hänger entfernen**: Sternreferenz zur Build-Zeit berechnen (Validator schreibt sie in die Level-Daten) oder Sterne an einfache Schwellen koppeln (Überlebende im Verhältnis zur maximal möglichen Truppgröße). | sehr hoch   | S       | 850 ms und mehr Einfrieren genau im Belohnungsmoment. Das Level-5-„immer 3 Sterne“-Problem verschwindet gleich mit. |
| 3   | **L4/L5 neu balancieren und Gates vereinheitlichen**: dieselbe Schwelle in Test und Validator, 20+ Seeds. L4/L5 so, dass der menschenähnliche Bot bei Tier 10 mindestens 30–50 % erreicht.                            | hoch        | S–M     | Heute ist CI rot und das Ende der Kampagne für normale Spieler unschaffbar.                                         |
| 4   | **Rückmeldung bei Niederlage**: erreichter Fortschritt in %, Rekord, Ursache („von Reihe 14 überrannt“ oder „Boss-Salve“). Münzen auch beim Abbruch über X gutschreiben.                                              | hoch        | S       | Aus „verloren“ wird „fast geschafft“, ganz ohne Dark Pattern.                                                       |
| 5   | **Für Touch balancieren**: einen menschenähnlichen Bot-Modus in `bot.ts` (gleiten statt springen, 150–200 ms Re-Aim, spätere Reaktion) als Maßstab für den Validator. Die Maus optional ebenfalls gleiten lassen.     | hoch        | M       | Ein Mobile-first-Spiel ist heute für Maus und Bot balanciert.                                                       |
| 6   | **Meta-Fortschritt nach den Caps**: Caps pro Level-Freischaltung anheben, oder Münzen bekommen neue Verwendungen (Startwaffe, Skins, Endlos-Modus).                                                                   | hoch        | M       | Ab Level 4 sind Münzen wertlos, das ist der zweite große Retention-Bruch.                                           |
| 7   | **Pause und Lifecycle**: Pause-Button, Auto-Pause bei `visibilitychange` und `blur`, Rückfrage beim X.                                                                                                                | mittel      | S       | Standard auf Mobilgeräten. Heute läuft man nach einem Anruf direkt in die Horde.                                    |
| 8   | **Lesbarkeit**: Mündungsfeuer und Kugeln bei großen Trupps dimmen oder zusammenfassen, das weiße Rechteck entfernen. Spur auf erreichbare Blöcke kürzen (keine 20K-/95K-Köder).                                       | mittel      | S–M     | Bei 40 Schützen sieht man nicht mehr, was passiert.                                                                 |
| 9   | **Level-Identität**: den Generator ins Repo, dazu pro Level eine eigene Regel (rechte Spur, Tank-Welle, schmale Formationen, Boss-Mechanik), Items variieren.                                                         | mittel–hoch | M–L     | Fünf Zahlen-Varianten desselben Levels tragen keine Kampagne.                                                       |
| 10  | **Robustheit und Auslieferung**: WebGL-Fallback (Menü ohne 3D-Demo) und `webglcontextlost`, Shooter per `import()` nachladen.                                                                                         | mittel      | M       | Ein Absturz auf schwachen Geräten wäre unsichtbar und tödlich. Das Bundle wird kleiner.                             |

---

## 4. Quick Wins (je unter einer Stunde)

- `delay` der ersten Welle in L1 auf etwa 5 s anheben und den Hinweis nach unten oder kürzer setzen,
  damit er nicht über der Spur liegt.
- Auf dem DEFEATED-Screen `progress` anzeigen (der Wert existiert schon in `GameMode.progress`).
- `toMenu()` schreibt `coinsEarned` gut, bevor der Mode verworfen wird.
- Die Upgrade-Leiste auf der Level-Auswahl erst einblenden, wenn Münzen vorhanden sind.
- Validator auf 20 Seeds stellen und dieselbe Schwelle wie im Test verwenden.
- Die `dry`-Metrik in `simulate-campaign.ts` korrigieren und die widersprüchlichen Sätze zu „fewer runs“
  / „half as many runs“ in README und Skript berichtigen.
- Float-Rauschen in den Level-JSONs runden (`3.6000000000000005`).
- `engines: { "node": ">=20" }` in `package.json`.
- Einen Screenshot und ein GIF ins README sowie den Pages-Link.
- `setPointerCapture` in `try/catch`.

---

## 5. Empfohlene Reihenfolge

1. **Stabilisieren (1 Tag):** Quick Wins, #2 (Sieg-Hänger), #3 (Gates vereinheitlichen, L4/L5 neu
   balancieren), dann den großen Working Tree in sinnvolle Commits aufteilen. Ziel: CI grün, kein
   Hänger.
2. **Die ersten 10 Minuten (1–2 Tage):** #1 (erster Run gewinnbar), #4 (Feedback bei Niederlage),
   #7 (Pause und Lifecycle). Danach Level 1–2 von einer Person testen lassen, die das Spiel nicht
   kennt, am echten Handy.
3. **Balancing auf Menschen umstellen (2 Tage):** #5 (menschenähnlicher Bot als Maßstab), Kurve neu
   kalibrieren (Ziel: L1 in 1–3 Runs, danach jeweils etwa 3–6 Runs, monoton steigend), dann #6
   (Meta-Fortschritt nach den Caps).
4. **Inhalt und Look (laufend):** #9 (Level-Identität, Generator ins Repo), #8 (Lesbarkeit).
5. **Open-Source-Politur:** #10 (Fallback, Code-Splitting), Templates, Changelog, Docs aus dem README
   auslagern.

---

## 6. Was ich nicht testen konnte (ausdrücklich)

- **Kein echtes Mobilgerät.** Getestet habe ich nur im mobilen Viewport (375×812, auch 812×375) des
  eingebauten Chromium-Browsers am Mac. Touch gab es nur über synthetische `PointerEvent`s, keine
  echten Gesten. iOS Safari, Android Chrome, Notch und Home-Indicator, echte Fingerpräzision: alles
  nicht geprüft.
- **Kein vollständiger Run von Hand.** Das Browser-Tool hat 1–2 s Latenz pro Aktion, für ein
  Echtzeit-Spiel reicht das nicht. Zwei eigene Versuche in L1 endeten nach etwa 8 s. Alle Aussagen zu
  Gewinnraten und Run-Zahlen stammen aus Simulationen: Projekt-Bot plus mein „menschenähnlicher“ Bot.
  Der ist eine Heuristik mit selbst gewählten Parametern, keine Messung an echten Spielern.
- **Performance nur auf dem Mac** (konstant 60 FPS bei etwa 50 Monstern und 40 Schützen). Keine
  Messung auf Mittelklasse- oder Low-End-Handys, keine Akku- oder Wärmemessung. Den Sieg-Hänger auf
  Handys habe ich nur hochgerechnet.
- **Audio** nicht angehört, nur den Code gelesen (die Drosselung in `sfx.ts` wirkt sinnvoll).
- **Breites Desktop-Layout** nur im schmalen Browser-Pane gesehen.
- **WebGL-Ausfall und Context Loss** nur aus dem Code abgeleitet, nicht reproduziert.
- **Screenreader und Tastatur-Navigation** der Menüs nicht geprüft.
- **Runner-Modus** absichtlich nicht bewertet (`CLAUDE.md`).
- **Der committete Stand (`HEAD`)** wurde nicht separat validiert. Alle Befunde beziehen sich auf den
  Working Tree mit den uncommitteten Änderungen.

### Reproduktion

```bash
npm run typecheck && npm run lint && npm run format:check   # grün
npm test                                                    # 104/104 grün
npm run build                                               # grün, Warnung: Chunk > 500 kB
npm run validate:levels                                     # Exit 1: FAIL 14-flood, 15-big-boss
npm run simulate:campaign                                   # 17 / 8 / 3 / 16 / 7 Runs
```

Die Gewinnraten pro Tier, der menschenähnliche Bot und die Zeitmessung von `referenceSurvivors()`
stammen aus eigenen Skripten im Scratch-Verzeichnis dieser Session, nicht im Repo. Den Sieg-Hänger
habe ich im Browser mit einer `requestAnimationFrame`-Sonde gemessen (längster Frame 850 ms beim
Wechsel zu `state=result`).

---

## 7. Umsetzungsstand: Phase 1 und 2 (2026-10-21, noch nicht committet)

| Punkt                      | Stand                                                                                                                                                                                                                                                                                  | Nachweis                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| #1 Erster Run gewinnbar    | L1 startet mit 3 Soldaten, die Spur hat erreichbare Blöcke (5 bis 1.400 HP statt 9 bis 20.000), die erste Welle kommt 3 s später. L2 ist etwas leichter, damit sich die Wand nicht dorthin verschiebt. Der Test verlangt jetzt: L1 ohne Upgrades schaffbar, alle späteren Level nicht. | Bot ohne Upgrades 100 %, menschenähnlicher Bot 100 % (je 20 Runs)                                                |
| #2 Sieg-Hänger             | Sterne vergleichen die Überlebenden mit dem größten Trupp des Runs (`StationaryMode.stars`, `sim.peak`), zur Laufzeit läuft kein Bot mehr.                                                                                                                                             | Längster Schritt beim Sieg 1,5 ms (vorher 850 ms)                                                                |
| #3 Gates und L4/L5         | `WIN_RATE_TARGET` (60 %) und `VALIDATION_RUNS` (20) in `bot.ts` gelten für Validator und Tests, die Tier-Suche läuft per Bisektion. L4 hat eine dünnere Horde und günstigere Blöcke mitten in der Spur, L5 eine günstigere Spur.                                                       | `validate:levels` grün. Bot mit Tier 10: L4 100 %, L5 80 %. Menschenähnlicher Bot: L4 55 %, L5 65 % (vorher 0 %) |
| #4 Feedback bei Niederlage | Fortschrittsbalken mit Markierung für den bisherigen Rekord, „New record“, Ursache („The horde broke through.“ oder „A boss volley…“). Rekorde stehen in `SaveData.progress`.                                                                                                          | Im Browser geprüft                                                                                               |
| #7 Pause                   | Pause-Button im Shooter-HUD, `Esc` / `P`, automatische Pause bei `blur` und `visibilitychange`. Der Pause-Screen bietet RESUME, RETRY und MENU; beim Verlassen werden Münzen und Rekord gutgeschrieben. Der Runner ist unverändert (X verlässt das Level, keine Pause).                | Im Browser geprüft                                                                                               |
| Quick Wins                 | Hinweis tiefer und kürzer, Upgrade-Leiste erst ab dem ersten Run sichtbar, `dry`-Metrik und Doku-Widersprüche korrigiert, Float-Rauschen gerundet, `engines` gesetzt, `setPointerCapture` abgesichert.                                                                                 |                                                                                                                  |
| Offen                      | Screenshot/GIF und Pages-Link im README (es gibt keinen Remote, und eine Aufnahme braucht ein echtes Gerät), Aufteilen in Commits.                                                                                                                                                     |                                                                                                                  |

Kampagne mit dem menschenähnlichen Bot jetzt: 1 / 15 / 18 / 10 / 2 Runs (vorher 29 / 23 / 1 / in 150 Runs nicht geschafft).
Projekt-Bot (`npm run simulate:campaign`): 1 / 9 / 15 / 2 / 4 Runs. L2 und L3 bleiben der längste Abschnitt;
die Kurve weiter zu glätten gehört zu Phase 3.
