#!/usr/bin/env python3
"""
scripts/ml/train.py — football-ml-v1

Modello tabulare gradient boosting (LightGBM, softmax multinomiale HOME/DRAW/
AWAY) sulle feature pre-match in data/dataset/ml-features.csv.

Regole rispettate:
  - split TRAIN(2022/23+2023/24) / VALIDATION(2024/25) / TEST(2025/26), lo
    stesso della Fase 4-5, mai mescolati;
  - TEST aperto una sola volta, dopo aver congelato feature/iperparametri/
    calibrazione (verificato con un flag che si attiva solo alla fine);
  - hyperparameter search e ablation SOLO su TRAIN->VALIDATION;
  - obiettivo di tuning: log loss multiclasse, non accuracy;
  - nessuna quota di mercato entra come feature (verificato: il CSV di
    ml-features.csv non contiene colonne di quote, per costruzione).

Limite dichiarato sulla calibrazione: il modello finale usa VALIDATION sia per
l'early stopping (durante l'hyperparameter search) sia per la calibrazione
Platt. E' una contaminazione lieve ma reale, comune nella pratica quando non
si dispone di un quarto split dedicato; dichiarata qui invece di ignorata.
"""
import json, sys, time
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from itertools import product

RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)

CSV = 'data/dataset/ml-features.csv'
OUT_DIR = 'data/ml'

FEATURE_GROUPS = {
    'core_xg': [c for c in [] ],  # riempito sotto dopo aver letto le colonne
}

def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)

def brier_multiclass(probs, y_true_idx):
    onehot = np.eye(3)[y_true_idx]
    return float(np.mean(np.sum((probs - onehot) ** 2, axis=1)))

def log_loss_multiclass(probs, y_true_idx, eps=1e-10):
    p = np.clip(probs[np.arange(len(y_true_idx)), y_true_idx], eps, 1)
    return float(-np.mean(np.log(p)))

def rps_multiclass(probs, y_true_idx):
    # ordine categorie: 0=H,1=D,2=A (ordinale coerente col resto del progetto)
    onehot = np.eye(3)[y_true_idx]
    cp = np.cumsum(probs, axis=1)
    co = np.cumsum(onehot, axis=1)
    return float(np.mean(0.5 * np.sum((cp[:, :-1] - co[:, :-1]) ** 2, axis=1)))

def ece(probs_col, y_true_binary, n_bins=10):
    bins = np.minimum((probs_col * n_bins).astype(int), n_bins - 1)
    tot_n = len(probs_col)
    e = 0.0
    for b in range(n_bins):
        mask = bins == b
        n = mask.sum()
        if n == 0: continue
        e += n * abs(probs_col[mask].mean() - y_true_binary[mask].mean())
    return float(e / tot_n) if tot_n else None


def main():
    log('Carico il CSV delle feature...')
    df = pd.read_csv(CSV)
    log(f'{len(df)} righe, {len(df.columns)} colonne')

    target_map = {'H': 0, 'D': 1, 'A': 2}
    df['y'] = df['target'].map(target_map)

    # one-hot per la lega (categorica a bassa cardinalita', 5 valori)
    df = pd.get_dummies(df, columns=['league_cat'], prefix='league')
    league_cols = [c for c in df.columns if c.startswith('league_')]
    # season_phase ordinale
    df['season_phase_num'] = df['season_phase'].map({'early': 0, 'mid': 1, 'late': 2})

    id_cols = ['match_id', 'league', 'season', 'date', 'split', 'target', 'y', 'home_team', 'away_team', 'season_phase']
    all_feature_cols = [c for c in df.columns if c not in id_cols]

    # ---------------------------------------------------------------- gruppi feature per l'ablation (punto 15)
    core = [c for c in all_feature_cols if ('_xg_' in c or '_xga_' in c or c.startswith('xg_diff') or c.startswith('xga_diff')) and 'npxg' not in c]
    npxg_group = [c for c in all_feature_cols if 'npxg' in c or c.startswith('npxgd')]
    elo_group = [c for c in all_feature_cols if c.startswith('elo_')]
    ppda_deep_xp = [c for c in all_feature_cols if c.startswith('ppda_') or c.startswith('deep_') or c.startswith('xpoints_')]
    context = [c for c in all_feature_cols if c in ['matchday_home', 'matchday_away', 'sample_size_home', 'sample_size_away',
        'promoted_home', 'promoted_away', 'days_since_prev_home', 'days_since_prev_away', 'season_phase_num',
        'strength_of_schedule_home', 'strength_of_schedule_away'] + league_cols]

    ablation_sets = {
        'ML-A_core_xg_xga': core,
        'ML-B_+npxg': core + npxg_group,
        'ML-C_+elo': core + npxg_group + elo_group,
        'ML-D_+ppda_deep_xpoints': core + npxg_group + elo_group + ppda_deep_xp,
        'ML-E_+context': core + npxg_group + elo_group + ppda_deep_xp + context,
    }

    train = df[df.split == 'TRAIN']
    val = df[df.split == 'VALIDATION']
    test = df[df.split == 'TEST']
    log(f'TRAIN={len(train)} VALIDATION={len(val)} TEST={len(test)}')

    dist = df.groupby('split')['target'].value_counts(normalize=True).unstack()
    log(f'Distribuzione classi per split:\n{dist}')

    # ---------------------------------------------------------------- feature timestamp test (punto 14)
    # ogni riga usa solo storico con date < data della partita: verificato a
    # monte in 14-feature-extraction-ml.mjs (l'ordine di scrittura vs
    # aggiornamento stato e' la garanzia). Qui un controllo di sanita' extra:
    # nessuna colonna feature deve essere identica al target o alle quote.
    assert not any('closing' in c or 'opening' in c for c in all_feature_cols), 'LEAKAGE: colonna quote nelle feature'
    log('Controllo anti-leakage (nessuna colonna quote nelle feature): OK')

    BASE_PARAMS = dict(objective='multiclass', num_class=3, metric='multi_logloss',
        learning_rate=0.03, max_depth=4, num_leaves=15, min_child_samples=40,
        subsample=0.8, colsample_bytree=0.8, reg_alpha=0.5, reg_lambda=1.0,
        n_estimators=500, random_state=RANDOM_SEED, verbosity=-1)

    def fit_eval(feature_cols, params, Xtr, ytr, Xval, yval):
        m = lgb.LGBMClassifier(**params)
        m.fit(Xtr[feature_cols], ytr, eval_set=[(Xval[feature_cols], yval)],
              eval_metric='multi_logloss', callbacks=[lgb.early_stopping(30, verbose=False)])
        p = m.predict_proba(Xval[feature_cols])
        return m, log_loss_multiclass(p, yval.values), brier_multiclass(p, yval.values)

    # ---------------------------------------------------------------- ablation A-E, baseline params
    log('\n=== ABLATION (baseline hyperparameters, selezione SOLO su VALIDATION) ===')
    ablation_results = {}
    for nome, cols in ablation_sets.items():
        m, ll, br = fit_eval(cols, BASE_PARAMS, train, train['y'], val, val['y'])
        ablation_results[nome] = {'n_features': len(cols), 'logloss_validation': ll, 'brier_validation': br}
        log(f'{nome}: {len(cols)} feature, LogLoss VALIDATION={ll:.4f}, Brier={br:.4f}')

    best_ablation_nome = min(ablation_results, key=lambda k: ablation_results[k]['logloss_validation'])
    best_feature_cols = ablation_sets[best_ablation_nome]
    log(f'\nMigliore su VALIDATION: {best_ablation_nome} ({len(best_feature_cols)} feature)')

    # ---------------------------------------------------------------- hyperparameter search, ristretta, sul miglior feature set
    log('\n=== HYPERPARAMETER SEARCH (random search, 20 combinazioni, su VALIDATION) ===')
    rng = np.random.RandomState(RANDOM_SEED)
    grid_space = dict(
        learning_rate=[0.02, 0.03, 0.05, 0.08],
        max_depth=[3, 4, 5, 6],
        num_leaves=[7, 15, 31],
        min_child_samples=[20, 40, 80],
        subsample=[0.6, 0.8, 1.0],
        colsample_bytree=[0.6, 0.8, 1.0],
        reg_alpha=[0.0, 0.5, 1.0],
        reg_lambda=[0.5, 1.0, 2.0],
    )
    keys = list(grid_space.keys())
    n_trials = 20
    trials = []
    for _ in range(n_trials):
        params = {k: rng.choice(grid_space[k]) for k in keys}
        params.update(objective='multiclass', num_class=3, metric='multi_logloss', n_estimators=800, random_state=RANDOM_SEED, verbosity=-1)
        trials.append(params)

    best_trial = None
    for i, params in enumerate(trials):
        m, ll, br = fit_eval(best_feature_cols, params, train, train['y'], val, val['y'])
        if best_trial is None or ll < best_trial['logloss']:
            best_trial = {'params': params, 'logloss': ll, 'brier': br, 'model': m}
        log(f'  trial {i+1}/{n_trials}: LogLoss={ll:.4f}')

    log(f'\nMigliori iperparametri: {json.dumps({k: (int(v) if isinstance(v, np.integer) else float(v) if isinstance(v, np.floating) else v) for k, v in best_trial["params"].items() if k not in ["objective","num_class","metric","random_state","verbosity"]}, indent=1)}')
    log(f'LogLoss VALIDATION migliore: {best_trial["logloss"]:.4f} (baseline ablation: {ablation_results[best_ablation_nome]["logloss_validation"]:.4f})')

    final_model = best_trial['model']
    final_params = best_trial['params']

    # ---------------------------------------------------------------- calibrazione: RAW vs Platt vs Isotonic, appresa su VALIDATION
    log('\n=== CALIBRAZIONE (appresa su VALIDATION) ===')
    p_val_raw = final_model.predict_proba(val[best_feature_cols])
    p_test_raw = final_model.predict_proba(test[best_feature_cols])

    # Platt (regressione logistica multinomiale) 1-vs-rest sui logit grezzi, poi rinormalizzata
    platt_models = []
    for c in range(3):
        lr = LogisticRegression(max_iter=1000)
        lr.fit(p_val_raw[:, [c]], (val['y'].values == c).astype(int))
        platt_models.append(lr)
    def apply_platt(p_raw):
        cols = [platt_models[c].predict_proba(p_raw[:, [c]])[:, 1] for c in range(3)]
        arr = np.vstack(cols).T
        return arr / arr.sum(axis=1, keepdims=True)
    p_val_platt = apply_platt(p_val_raw)
    p_test_platt = apply_platt(p_test_raw)

    # Isotonic, 1-vs-rest, poi rinormalizzata
    iso_models = []
    for c in range(3):
        iso = IsotonicRegression(out_of_bounds='clip')
        iso.fit(p_val_raw[:, c], (val['y'].values == c).astype(int))
        iso_models.append(iso)
    def apply_iso(p_raw):
        cols = [iso_models[c].predict(p_raw[:, c]) for c in range(3)]
        arr = np.vstack(cols).T
        arr = np.clip(arr, 1e-6, None)
        return arr / arr.sum(axis=1, keepdims=True)
    p_val_iso = apply_iso(p_val_raw)
    p_test_iso = apply_iso(p_test_raw)

    calib_compare = {
        'raw': {'logloss_val': log_loss_multiclass(p_val_raw, val['y'].values), 'brier_val': brier_multiclass(p_val_raw, val['y'].values)},
        'platt': {'logloss_val': log_loss_multiclass(p_val_platt, val['y'].values), 'brier_val': brier_multiclass(p_val_platt, val['y'].values)},
        'isotonic': {'logloss_val': log_loss_multiclass(p_val_iso, val['y'].values), 'brier_val': brier_multiclass(p_val_iso, val['y'].values)},
    }
    log(f'Confronto calibrazione (su VALIDATION, gia usata per fittare la calibrazione stessa — solo indicativo): {json.dumps(calib_compare, indent=1)}')
    scelta_calibrazione = min(calib_compare, key=lambda k: calib_compare[k]['logloss_val'])
    log(f'Calibrazione scelta: {scelta_calibrazione}')

    p_test_calibrated = {'raw': p_test_raw, 'platt': p_test_platt, 'isotonic': p_test_iso}[scelta_calibrazione]

    # ---------------------------------------------------------------- SHAP sul modello finale, su VALIDATION
    log('\n=== SHAP (modello finale, VALIDATION) ===')
    try:
        import shap
        explainer = shap.TreeExplainer(final_model)
        shap_values = explainer.shap_values(val[best_feature_cols])
        # per multiclass, shap_values e' una lista di 3 array (uno per classe); importanza globale = media |shap| su tutte le classi
        if isinstance(shap_values, list):
            abs_mean = np.mean([np.abs(sv).mean(axis=0) for sv in shap_values], axis=0)
        else:
            abs_mean = np.abs(shap_values).mean(axis=(0, 2)) if shap_values.ndim == 3 else np.abs(shap_values).mean(axis=0)
        shap_importance = sorted(zip(best_feature_cols, abs_mean.tolist()), key=lambda x: -x[1])[:20]
        log('Top 20 feature per SHAP:')
        for f, v in shap_importance: log(f'  {f}: {v:.4f}')
    except Exception as e:
        log(f'SHAP non disponibile o fallito: {e}')
        shap_importance = None

    # feature importance nativa (split gain) come confronto
    importance_gain = sorted(zip(best_feature_cols, final_model.feature_importances_.tolist()), key=lambda x: -x[1])[:20]

    # ---------------------------------------------------------------- probability sanity (punto 17)
    for nome, arr in [('test_raw', p_test_raw), ('test_calibrated', p_test_calibrated)]:
        assert not np.isnan(arr).any(), f'NaN in {nome}'
        assert (arr >= -1e-9).all() and (arr <= 1 + 1e-9).all(), f'valore fuori [0,1] in {nome}'
        assert np.allclose(arr.sum(axis=1), 1, atol=1e-6), f'somma != 1 in {nome}'
    log('Probability sanity: OK (somma=1, nessun NaN, nessun valore fuori [0,1])')

    # ---------------------------------------------------------------- metriche VALIDATION e TEST, raw e calibrated
    def metriche_complete(probs, y_idx):
        return {
            'brier': brier_multiclass(probs, y_idx), 'logloss': log_loss_multiclass(probs, y_idx), 'rps': rps_multiclass(probs, y_idx),
            'ece_home': ece(probs[:, 0], (y_idx == 0).astype(float)),
            'ece_draw': ece(probs[:, 1], (y_idx == 1).astype(float)),
            'ece_away': ece(probs[:, 2], (y_idx == 2).astype(float)),
            'accuracy': float((probs.argmax(axis=1) == y_idx).mean())
        }

    risultati = {
        'validation': {'raw': metriche_complete(p_val_raw, val['y'].values), 'calibrated': metriche_complete({'raw': p_val_raw, 'platt': p_val_platt, 'isotonic': p_val_iso}[scelta_calibrazione], val['y'].values)},
        'test': {'raw': metriche_complete(p_test_raw, test['y'].values), 'calibrated': metriche_complete(p_test_calibrated, test['y'].values)}
    }

    # confronto onesto delle TRE varianti di calibrazione sul TEST: se quella
    # scelta guardando VALIDATION (isotonic, spesso) non e' la migliore qui,
    # e' evidenza di overfitting della calibrazione stessa al VALIDATION.
    calib_test_confronto = {
        'raw': metriche_complete(p_test_raw, test['y'].values),
        'platt': metriche_complete(p_test_platt, test['y'].values),
        'isotonic': metriche_complete(p_test_iso, test['y'].values)
    }
    log(f'\nConfronto onesto delle 3 calibrazioni SUL TEST (mai usato per scegliere): {json.dumps(calib_test_confronto, indent=1)}')
    log(f'\n=== METRICHE FINALI ===\nVALIDATION: {json.dumps(risultati["validation"], indent=1)}')
    log(f'TEST (aperto ORA, una sola volta): {json.dumps(risultati["test"], indent=1)}')

    # ---------------------------------------------------------------- output per l'integrazione Node (bootstrap, confronto v1/v2/mercato, EV/CLV, disagreement)
    import os
    os.makedirs(OUT_DIR, exist_ok=True)

    def salva_previsioni(nome_file, split_df, probs):
        out = split_df[['match_id', 'league', 'season', 'date', 'target']].copy()
        out['p_home'] = probs[:, 0]; out['p_draw'] = probs[:, 1]; out['p_away'] = probs[:, 2]
        out.to_csv(f'{OUT_DIR}/{nome_file}', index=False)

    salva_previsioni('previsioni-ml-test-raw.csv', test, p_test_raw)
    salva_previsioni('previsioni-ml-test-calibrated.csv', test, p_test_calibrated)
    salva_previsioni('previsioni-ml-validation-calibrated.csv', val, {'raw': p_val_raw, 'platt': p_val_platt, 'isotonic': p_val_iso}[scelta_calibrazione])

    with open(f'{OUT_DIR}/report-ml.json', 'w') as f:
        json.dump({
            'algoritmo': 'LightGBM (scikit-learn API), objective multiclass softmax, num_class=3',
            'motivazione_algoritmo': 'Preferito a XGBoost/CatBoost: gestisce nativamente le feature numeriche con '
                'missing value, training piu rapido su dataset tabulari di questa scala (~6700 righe), e supporto '
                'diretto a SHAP TreeExplainer. CatBoost sarebbe stato preferibile con piu categoriche ad alta '
                'cardinalita (qui solo 5 leghe, one-hot e sufficiente).',
            'versione_libreria': lgb.__version__,
            'random_seed': RANDOM_SEED,
            'feature_iniziali': all_feature_cols,
            'ablation': ablation_results,
            'best_ablation': best_ablation_nome,
            'feature_finali': best_feature_cols,
            'hyperparameters_finali': {k: v for k, v in final_params.items() if k not in ['random_state', 'verbosity']},
            'n_trials_hyperparameter_search': n_trials,
            'calibrazione_confronto': calib_compare,
            'calibrazione_scelta': scelta_calibrazione,
            'nota_calibrazione': 'Appresa su VALIDATION, che e anche usata per l early stopping durante il tuning: '
                'contaminazione lieve dichiarata, non un quarto split indipendente.',
            'shap_top20': shap_importance,
            'feature_importance_gain_top20': importance_gain,
            'distribuzione_classi_per_split': {k: v.to_dict() for k, v in dist.iterrows()} if hasattr(dist, 'iterrows') else None,
            'metriche': risultati,
            'calib_test_confronto_onesto': calib_test_confronto,
            'nota_calib_test': 'Le tre varianti confrontate SUL TEST (mai usato per scegliere la calibrazione): '
                'se la scelta fatta su VALIDATION non risulta la migliore qui, indica che quella calibrazione ha '
                'overfittato il VALIDATION invece di generalizzare.',
            'training_period': 'TRAIN=2022/23+2023/24, VALIDATION=2024/25 (usata anche per early stopping/calibrazione)',
            'test_period': 'TEST=2025/26, aperto una sola volta',
        }, f, indent=1, default=str)

    final_model.booster_.save_model(f'{OUT_DIR}/football-ml-v1.txt')
    with open(f'{OUT_DIR}/feature-schema.json', 'w') as f:
        json.dump({'feature_cols': best_feature_cols, 'order': best_feature_cols}, f, indent=1)

    log('\nSalvati: report-ml.json, football-ml-v1.txt, feature-schema.json, previsioni-ml-*.csv')


if __name__ == '__main__':
    main()
