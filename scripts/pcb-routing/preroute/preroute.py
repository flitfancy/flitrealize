"""One isolated JSON job: --mode route|fanout|diagnose|ground --input FILE --output DIR."""
import argparse
import json
from pathlib import Path
import sys

try:
    from .router import route, fanout, diagnose
    from .ground import ground_space
except ImportError:
    from router import route, fanout, diagnose
    from ground import ground_space


def write_json(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf8')
    temporary.replace(file)


def run_job(mode, data, output, candidate=None, candidate_mode='replace', save_arrays=True):
    """Execute one job and return the output manifest. No import-time file access."""
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if mode == 'route':
        result = route(data, checkpoint=lambda value: write_json(output / 'route-result.json', value),
                       progress=lambda value: print(json.dumps(value), file=sys.stderr, flush=True))
        write_json(output / 'route-result.json', result)
        return {'mode': mode, 'status': result['status'], 'resultFile': str(output / 'route-result.json'),
                'addedSegments': len(result['segments']), 'addedVias': len(result['vias']), 'nets': len(result['nets']), 'nativeWrites': 0}
    if mode in ['fanout', 'diagnose']:
        result = fanout(data) if mode == 'fanout' else diagnose(data)
        file = output / ('fanout-result.json' if mode == 'fanout' else 'diagnosis.json')
        write_json(file, result)
        return {'mode': mode, 'status': result['status'], 'resultFile': str(file), 'nativeWrites': 0}
    if mode == 'ground':
        space, graph, arrays = ground_space(data, candidate, candidate_mode)
        write_json(output / 'ground-space.json', space)
        write_json(output / 'ground-link-plan.json', graph)
        if save_arrays:
            import numpy as np
            np.savez_compressed(output / 'ground-space.npz', **arrays)
        return {'mode': mode, 'status': space['status'], 'spaceFile': str(output / 'ground-space.json'),
                'graphFile': str(output / 'ground-link-plan.json'), 'graphStatus': graph['status'],
                'sourceCopperVias': space['sourceCopperVias'], 'groundPads': graph['groundPads'],
                'potentialReachableGroundPads': graph['potentialReachableGroundPads'],
                'transitionSlotsMissingWithinRadius': space['transitionSlotsMissingWithinRadius'],
                'groundCopperCreated': False, 'groundConnectivityVerified': False, 'nativeWrites': 0}
    raise ValueError('PREROUTE_MODE:' + str(mode))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['route', 'fanout', 'diagnose', 'ground'], required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--candidate', help='Ground mode only: a candidate copper JSON file')
    parser.add_argument('--candidate-mode', choices=['replace', 'additions'], default='replace')
    parser.add_argument('--no-arrays', action='store_true')
    args = parser.parse_args(argv)
    if args.candidate and args.mode != 'ground':
        parser.error('--candidate is supported only by ground mode')
    data = json.loads(Path(args.input).read_text(encoding='utf-8-sig'))
    candidate = json.loads(Path(args.candidate).read_text(encoding='utf-8-sig')) if args.candidate else None
    print(json.dumps(run_job(args.mode, data, args.output, candidate, args.candidate_mode, not args.no_arrays), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
