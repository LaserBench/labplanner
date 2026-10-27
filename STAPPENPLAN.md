# Labplanner online zetten (GitHub + Supabase)

Vink af wat klaar is. **Jij** = in je browser, **Claude** = gebeurt vanuit deze sessie.

## Fase 1: GitHub-repository (jij, 2 min)
- [ ] Ga naar **github.com/new**
- [ ] Repository name: `labplanner`
- [ ] **Public** (de pagina bevat geen patiëntgegevens; die staan achter de login in Supabase)
- [ ] *Niets* aanvinken: geen README, geen .gitignore, geen license
- [ ] **Create repository** → stuur de link naar Claude

## Fase 2: Supabase-project (jij, 5 min)
- [ ] **supabase.com/dashboard** → **New project**
- [ ] Organization: je Pro-organisatie
- [ ] Project name: `labplanner`
- [ ] Database password: *Generate*, bewaren in je wachtwoordmanager
- [ ] Region: **Central EU (Frankfurt)** (AVG)
- [ ] Compute: **Micro** (valt binnen de Pro-credits)
- [ ] Data API: **aan** (als die optie zichtbaar is)
- [ ] **Create new project**, 1 à 2 minuten wachten

## Fase 3: Inloggen instellen (jij, 3 min)
- [ ] **Authentication → Sign In / Providers** → *Allow new users to sign up* **uit** → Save
- [ ] **Authentication → Users → Add user → Create new user**
  - [ ] Account pap: e-mail + wachtwoord, **Auto Confirm User** aan
  - [ ] Account jij: e-mail + wachtwoord, **Auto Confirm User** aan

## Fase 4: Sleutels naar Claude (jij, 1 min)
- [ ] **Project Settings → API Keys**
- [ ] Kopieer **Project URL** (`https://….supabase.co`, eventueel onder *Data API* of de knop *Connect*)
- [ ] Kopieer **Publishable key** (`sb_publishable_…`), of *anon public* onder *Legacy API keys*
- [ ] Stuur beide naar Claude
- [ ] ⚠️ **Nooit** de *secret* of *service_role* key delen

## Fase 5: Eerste push (Claude)
- [ ] URL en key invullen in `index.html`
- [ ] `git init`, commit, push naar `main` (zonder databasebestand)
- [ ] Jij: als Windows om GitHub-login vraagt, één keer inloggen in het pop-upvenster

## Fase 6: Supabase aan GitHub koppelen (jij, 2 min)
- [ ] Supabase → **Project Settings → Integrations → GitHub → Connect / Authorize**
- [ ] Repository: `labplanner`
- [ ] Supabase directory: `supabase`
- [ ] Production branch: `main`
- [ ] **Deploy to production: aan**
- [ ] **Automatic branching: uit**
- [ ] Opslaan / Enable integration → laat het Claude weten

## Fase 7: Database via GitHub aanmaken (Claude + jij)
- [ ] Claude: databasebestand `supabase/migrations/…_tasks.sql` committen en pushen → Supabase voert het uit
- [ ] Jij: in Supabase → **Table Editor**: tabel `tasks` is er
- [ ] Jij: **Database → Publications → supabase_realtime**: `tasks` staat aan

## Fase 8: Website online (jij, 2 min)
- [ ] GitHub → repo → **Settings → Pages**
- [ ] Source: **Deploy from a branch** → `main` → `/ (root)` → Save
- [ ] Na ±1 minuut: `https://<github-naam>.github.io/labplanner/`

## Fase 9: Testen (jij + Claude, 5 min)
- [ ] Link openen → inloggen met jouw account → statuslabel bovenin zegt **Online**
- [ ] Testopdracht aanmaken
- [ ] Supabase → Table Editor → `tasks`: de opdracht staat erin
- [ ] Zelfde link op je telefoon of in een tweede venster: wijziging verschijnt binnen een seconde
- [ ] Testopdracht verwijderen

## Fase 10: Overdracht aan pap
- [ ] Link naar pap sturen
- [ ] Op zijn apparaat: inloggen met zijn account, bovenin **Ik ben: TPP Meurers** kiezen
- [ ] Bladwijzer maken of op telefoon *Toevoegen aan beginscherm*

## Daarna: wijzigingen
Zeg tegen Claude wat je anders wilt. Claude past `index.html` aan of voegt een nieuw bestand toe in `supabase/migrations/`, en pusht naar `main`. Supabase voert de databasewijziging uit, GitHub Pages zet de nieuwe pagina online. Pap ziet het na een paginaverversing.

Regel: een databasebestand dat al is uitgevoerd, wordt nooit meer aangepast. Elke wijziging is een nieuw bestand.

## Volgende functie
- [ ] Factuurgenerator: opdracht op **Klaar** zetten → factuur wordt automatisch opgebouwd en bewaard
