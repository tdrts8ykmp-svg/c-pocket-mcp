"""Bounded JSON bridge for embedding in the existing C Pocket MCP service."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from storage import GameStore
from game import chapter


def dispatch(request):
    action = request.get('action')
    args = request.get('args', {})
    store = GameStore(request['db_path'])
    if action == 'ping':
        for language in ('zh', 'en'):
            for number in range(1, 33):
                chapter(language, number)
        return {'ready': True, 'chapters': 32}
    if action == 'start':
        return store.start(args.get('language', 'zh'), args.get('difficulty', 'casual'))
    if action == 'scene':
        return store.get(args['game_id'])
    if action == 'choose':
        return store.mutate(args['game_id'], 'choose', args['turn'], args['choice'], args.get('note', ''))
    if action == 'continue':
        return store.mutate(args['game_id'], 'continue', args['turn'])
    if action == 'history':
        return store.history(args['game_id'], args.get('offset', 0), args.get('limit', 30))
    raise ValueError('Unsupported game action')


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('Request too large')
        result = dispatch(json.loads(raw))
        output = {'ok': True, 'result': result}
    except ValueError as error:
        output = {'ok': False, 'error': str(error)}
    except Exception:
        output = {'ok': False, 'error': 'Game operation failed; saved progress was not advanced. Try get_scene again.'}
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode('utf-8'))
