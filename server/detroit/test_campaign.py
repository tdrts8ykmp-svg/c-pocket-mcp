import copy
import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import game
from storage import GameStore


class CampaignTests(unittest.TestCase):
    def test_opening_and_resume_never_expose_future_story_or_endings(self):
        for language in ('zh', 'en'):
            with self.subTest(language=language), tempfile.TemporaryDirectory() as directory:
                initial = game.new_game(language)
                data = copy.deepcopy(game.chapter(language, 1))
                marker = 'UNREACHED_STORY_MUST_NEVER_REACH_THE_PLAYER'
                for node in data['nodes'][initial['cursor'] + 1:]:
                    node['player_facing'] = {'context': marker}
                for ending in data['endings'].values():
                    if isinstance(ending, dict):
                        ending.update(title=marker, narrative=marker)
                read_chapters = []

                def only_first_chapter(requested_language, number):
                    self.assertEqual(requested_language, language)
                    self.assertEqual(number, 1, 'Opening a game must not inspect future chapters')
                    read_chapters.append(number)
                    return data

                with patch('game.chapter', side_effect=only_first_chapter):
                    store = GameStore(str(Path(directory) / 'games.sqlite3'))
                    opened = store.start(language, 'casual')
                    key = opened['game_id']
                    outputs = [opened, store.get(key), store.history(key), store.history(key, 99999)]
                    with self.assertRaises(ValueError):
                        store.mutate(key, 'continue', opened['turn'])
                    outputs.append(store.get(key))
                self.assertTrue(read_chapters)
                self.assertNotIn(marker, json.dumps(outputs))
                self.assertEqual(outputs[2]['chapter_summaries'], [])
                self.assertEqual(outputs[3]['events'], [])
                self.assertEqual(outputs[-1]['turn'], 0)
                self.assertNotIn('chapter_result', opened)

    def test_complete_campaigns_with_restart_at_every_move(self):
        for language in ('zh', 'en'):
            for difficulty in ('casual', 'experienced', 'hardcore'):
                for strategy in ('first', 'last', 'random'):
                    with self.subTest(language=language, difficulty=difficulty, strategy=strategy):
                        current = game.new_game(language, difficulty, seed=128)
                        rng = random.Random(281)
                        moves = 0
                        while current['phase'] != 'complete':
                            current = json.loads(json.dumps(current))
                            if current['phase'] == 'chapter_complete':
                                game.continue_game(current, current['revision'])
                            else:
                                size = len(current['pending']['choices'])
                                pick = 1 if strategy == 'first' else size if strategy == 'last' else rng.randint(1, size)
                                game.choose(current, current['revision'], pick)
                            moves += 1
                            self.assertLess(moves, 2500)
                            shown = game.view(current)
                            self.assertFalse({'state', 'seed', 'cross_state', 'endings'} & shown.keys())
                            if 'scene' in shown:
                                for choice in shown['scene']['choices']:
                                    self.assertEqual(set(choice), {'number', 'text'})
                        self.assertEqual(current['chapter'], 32)
                        self.assertEqual(len([h for h in current['history'] if h['kind'] == 'chapter_end']), 32)


if __name__ == '__main__':
    unittest.main()
