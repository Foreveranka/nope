"""Deterministic clean4 compiler source. No keys, filesystem or historical imports.

Bit layout and Boolean circuit match provenance/run_experiment.py.txt's clean.
All-zero/all-one fixtures establish the full uint1 range for every input bit.
"""


def less_bits(a, b):
    lt = 0
    equal = 1
    for k in range(len(a) - 1, -1, -1):
        lt = lt | (equal & (1 ^ a[k]) & b[k])
        equal = equal & (1 ^ (a[k] ^ b[k]))
    return lt


def clean(x):
    from concrete import fhe
    fields = [x[i * 8:(i + 1) * 8] for i in range(8)]
    flags = []
    for i in range(4):
        duplicate = x[0] & 0
        for j in range(i):
            same = 1
            for k in range(8):
                same = same & (1 ^ (fields[i][k] ^ fields[j][k]))
            duplicate = duplicate | same
        flags.append(duplicate)
    values = []
    cap = [(100 >> k) & 1 for k in range(8)]
    for value in fields[4:]:
        missing = 1
        for k in range(8):
            missing = missing & value[k]
        above = less_bits(cap, value)
        values += [(value[k] ^ ((value[k] ^ cap[k]) & above)) & (1 ^ missing)
                   for k in range(8)]
    return fhe.array(flags + values)


OPTIONS = {"global_p_error": 1e-8,
           "comparison_strategy_preference": "chunked",
           "bitwise_strategy_preference": "chunked",
           "min_max_strategy_preference": "chunked",
           "enable_unsafe_features": False,
           "use_insecure_key_cache": False,
           "use_gpu": False,
           "fhe_simulation": False,
           "fhe_execution": True,
           "dump_artifacts_on_unexpected_failures": False}


def configuration():
    from concrete import fhe
    return fhe.Configuration(**OPTIONS)


def inputset():
    import numpy as np
    # Fully deterministic bounds, no RNG and no cryptographic entropy override.
    return [np.full(64, bit, dtype=np.int64) for bit in (0, 1)]


def compile_circuit():
    from concrete import fhe
    return fhe.Compiler(clean, {"x": "encrypted"}).compile(
        inputset(), configuration=configuration())
