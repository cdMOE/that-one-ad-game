# Crowd Runner

Das Spiel hat zwei Modi: **Shooter** (`src/modes/stationary.ts`, `src/modes/stationary/`) und **Runner** (`src/modes/runner.ts`).

## Aktueller Fokus: nur Shooter

- Arbeite ausschließlich am Shooter-Modus (stationary), sofern nicht ausdrücklich anders gesagt.
- Der Runner-Modus ist vorerst eingefroren: nicht ändern, nicht refactoren, nicht "nebenbei verbessern", keine Tests/Balance/Doku dafür anpassen.
- Gemeinsamer Code (`src/core/`, `src/ui/`, `src/game.ts`, `src/modes/mode.ts`) darf für den Shooter geändert werden, aber so, dass der Runner nicht kaputtgeht (Typecheck/Tests müssen weiter durchlaufen). Falls eine Änderung das Runner-Verhalten betreffen würde, vorher nachfragen.
- Vorschläge, Reviews und Ideen beziehen sich nur auf den Shooter.
