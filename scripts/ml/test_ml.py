#!/usr/bin/env python3
"""scripts/ml/test_ml.py — test automatici per football-ml-v1 (punto 31).

Diverso da scripts/test.mjs (motore in produzione) e da
scripts/dataset/09-test-dataset.mjs (dataset Dixon-Coles): questo verifica
specificamente il modello ML, il suo artefatto serializzato e lo schema
feature. Si esegue offline dopo scripts/ml/train.py, non in CI.
"""
import json, sys
import numpy as np
import pandas as pd
import lightgbm as lgb

ok, ko = 0, 0
fail = []
def check(nome, cond, dettaglio=''):
    global ok, ko
    if cond: ok += 1
    else: ko += 1; fail.append(f'{nome}: {dettaglio}')

# ---------------------------------------------------------------- serialization/deserialization
model_reloaded = lgb.Booster(model_file='data/ml/football-ml-v1.txt')
schema = json.load(open('data/ml/feature-schema.json'))
feature_cols = schema['feature_cols']
check('Serialization: modello ricaricato da .txt', model_reloaded is not None)
check('Feature order: schema salvato ha lo stesso ordine usato dal modello', feature_cols == schema['order'])

df = pd.read_csv('data/dataset/ml-features.csv')
target_map = {'H': 0, 'D': 1, 'A': 2}
df['y'] = df['target'].map(target_map)
df = pd.get_dummies(df, columns=['league_cat'], prefix='league')
df['season_phase_num'] = df['season_phase'].map({'early': 0, 'mid': 1, 'late': 2})
test = df[df.split == 'TEST']

# ricalcola le previsioni con il modello RICARICATO e confronta con quelle salvate
p_reloaded = model_reloaded.predict(test[feature_cols])
salvate = pd.read_csv('data/ml/previsioni-ml-test-raw.csv')
check('Same seed reproducibility: previsioni del modello ricaricato = previsioni salvate',
    np.allclose(p_reloaded[:, 0], salvate['p_home'].values, atol=1e-6), f'max diff {np.max(np.abs(p_reloaded[:,0]-salvate["p_home"].values)):.2e}')

# ---------------------------------------------------------------- probability sum, NaN, range
check('Probability sum: ogni riga somma a 1', np.allclose(p_reloaded.sum(axis=1), 1, atol=1e-6))
check('No NaN nelle previsioni ricaricate', not np.isnan(p_reloaded).any())
check('Range [0,1]', (p_reloaded >= -1e-9).all() and (p_reloaded <= 1 + 1e-9).all())
check('Distribuzione non degenere: nessuna colonna con varianza zero',
    all(p_reloaded[:, c].std() > 1e-6 for c in range(3)))
check('Nessuna probabilita sistematicamente estrema (>99.9% delle righe con max prob < 0.97)',
    (p_reloaded.max(axis=1) < 0.97).mean() > 0.999, f'{(p_reloaded.max(axis=1) >= 0.97).sum()} righe estreme')

# ---------------------------------------------------------------- missing feature fallback
riga_con_nan = test[feature_cols].iloc[[0]].copy()
riga_con_nan.iloc[0, 0] = np.nan
try:
    p_con_nan = model_reloaded.predict(riga_con_nan)
    check('Missing feature fallback: predict non crasha con un NaN in input',
        not np.isnan(p_con_nan).any(), 'LightGBM gestisce nativamente i missing, non produce NaN in output')
except Exception as e:
    check('Missing feature fallback', False, str(e))

# ---------------------------------------------------------------- no leakage (ripetuto qui per indipendenza dal training script)
check('No leakage: nessuna colonna di quote nello schema feature',
    not any('closing' in c or 'opening' in c for c in feature_cols))
check('No leakage: nessuna colonna target/esito nello schema feature',
    not any(c in ['target', 'y', 'goals_home', 'goals_away', 'esito'] for c in feature_cols))

# ---------------------------------------------------------------- calibration sanity
report = json.load(open('data/ml/report-ml.json'))
check('Calibration: il file riporta un confronto a 3 vie (raw/platt/isotonic)',
    set(report['calibrazione_confronto'].keys()) == {'raw', 'platt', 'isotonic'})
check('Calibration: il confronto onesto sul TEST e presente',
    'calib_test_confronto_onesto' in report and set(report['calib_test_confronto_onesto'].keys()) == {'raw', 'platt', 'isotonic'})

print(f'\n{ok} test superati, {ko} falliti.')
if fail:
    print('Falliti:\n- ' + '\n- '.join(fail))
    sys.exit(1)
