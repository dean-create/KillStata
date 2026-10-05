# Card–Krueger public-data fixture

Source: David Card's official data page lists the New Jersey–Pennsylvania fast-food surveys and links `njmin.zip`; the archive README describes `public.dat` as 410 observations and includes a codebook and SAS checking program.

- Data page: https://davidcard.berkeley.edu/data_sets.html
- Archive README: https://davidcard.berkeley.edu/readme/njmin-readme.txt
- Archive: https://davidcard.berkeley.edu/data_sets/njmin.zip

The CSV is derived from the official fixed-width `public.dat`. For each source row, the pre-wave and post-wave employment outcomes are computed using the SAS program's definitions:

- `fte_pre = EMPFT + 0.5 * EMPPT + NMGRS`
- `fte_post = EMPFT2 + 0.5 * EMPPT2 + NMGRS2`

Each nonmissing wave outcome is retained as one long-format observation; no interpolation or imputation is done. The fixture therefore has 794 observed store-wave outcomes, not a balanced panel and not the narrower SAS `C1` Table 4 subset. `source_row` preserves the original row position. The source codebook says `SHEET` is unique, but the raw file repeats `SHEET=407` for two different chain/state records; both source rows are retained and the fixture does not treat `store` as a verified unique key.

The scripted `did_static` scenario verifies tool routing and the requested 2×2 coefficient computation on this public source-derived sample. It is not a reproduction of Table 4, does not validate within-store error correlation or parallel trends, and is not causal-identification evidence.
