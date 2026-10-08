"""Shared JSON search defaults; geometry/input files are never read at import."""
import json
from pathlib import Path

DEFAULTS = json.loads(Path(__file__).with_name('defaults.json').read_text(encoding='utf8'))
DEFAULT_ROUTING = DEFAULTS['routing']
DEFAULT_VIA = DEFAULTS['via']


def routing_config(data):
    routing = {**DEFAULT_ROUTING, **data.get('routing', {})}
    inherited = {field: data.get(source) for field, source in DEFAULTS['viaFromInput'].items()}
    via = {**DEFAULT_VIA, **inherited, **data.get('via', {})}
    return routing, via
