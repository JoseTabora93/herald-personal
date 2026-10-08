import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('personal_runtime', Path(__file__).with_name('personal_runtime.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_init_preserves_token_and_uses_private_storage(self):
        first = self.module.prepare_runtime(self.root)
        token = Path(first['HERALD_PERSONAL_TOKEN_FILE'])
        before = token.read_text()
        second = self.module.prepare_runtime(self.root)
        self.assertEqual(before, token.read_text())
        self.assertEqual(first, second)
        self.assertGreaterEqual(len(before.strip()), 40)
        self.assertEqual(token.stat().st_mode & 0o777, 0o600)
        self.assertEqual(token.parent.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('HERALD_PERSONAL_TOKEN', first)

    def test_init_rejects_symlink_or_public_credential(self):
        env = self.module.prepare_runtime(self.root)
        token = Path(env['HERALD_PERSONAL_TOKEN_FILE'])
        token.chmod(0o644)
        with self.assertRaises(ValueError): self.module.prepare_runtime(self.root)
        token.unlink()
        target = self.root / 'foreign'
        target.write_text('secret')
        token.symlink_to(target)
        with self.assertRaises(ValueError): self.module.prepare_runtime(self.root)

    def test_mail_settings_cannot_replace_api_token_or_execute_commands(self):
        self.module.prepare_runtime(self.root)
        settings = self.root / '.runtime/private/mail-settings.json'
        settings.write_text('{"HERALD_PERSONAL_TOKEN":"foreign", "PATH":"/bad"}')
        settings.chmod(0o600)
        with self.assertRaises(ValueError): self.module.prepare_runtime(self.root)

    def test_operator_inbox_mutations_are_off_by_default(self):
        env = self.module.prepare_runtime(self.root)
        self.assertEqual(env['HERALD_PERSONAL_MAIL_DRAFT_ENABLED'], 'false')
        self.assertEqual(env['HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED'], 'false')
        self.assertEqual(env['HERALD_PERSONAL_URL'], 'http://127.0.0.1:8787')

    def test_diagnostics_never_return_environment_secrets(self):
        env = self.module.prepare_runtime(self.root)
        env['HERALD_PERSONAL_TOKEN'] = 'do-not-print'
        output = self.module.diagnostics(self.root, env)
        self.assertNotIn('do-not-print', str(output))
        self.assertIn('python_installed', output)

    def install_fixture(self):
        self.module.prepare_runtime(self.root)
        installed = self.root / 'installed'
        for folder in ('private', 'data', 'hermes-home', 'logs', '.venv/bin', 'lib'):
            (installed / folder).mkdir(parents=True, mode=0o700)
        token = installed / 'private/api-token'
        token.write_text('rotated-installed-token')
        token.chmod(0o600)
        connection = installed / 'connection.json'
        connection.write_text(json.dumps({'url': 'http://127.0.0.1:8787', 'tokenFile': str(token)}))
        connection.chmod(0o600)
        manifest = self.root / '.runtime/private/installed-runtime.json'
        manifest.write_text(json.dumps({
            'dataDir': str(installed / 'data'), 'tokenFile': str(token),
            'hermesHome': str(installed / 'hermes-home'),
            'pythonPath': str(installed / '.venv/bin/python'), 'connectionFile': str(connection),
        }))
        manifest.chmod(0o600)
        return installed, manifest

    def test_installed_runtime_wins_over_stale_checkout_credentials(self):
        installed, _ = self.install_fixture()
        env = self.module.prepare_runtime(self.root)
        self.assertEqual(env['HERALD_PERSONAL_TOKEN_FILE'], str(installed / 'private/api-token'))
        self.assertEqual(env['HERALD_PERSONAL_DATA_DIR'], str(installed / 'data'))
        self.assertEqual(env['HERMES_HOME'], str(installed / 'hermes-home'))
        self.assertEqual(env['PYTHONPATH'], str(installed / 'lib'))
        self.assertEqual(self.module.runtime_python(self.root, env), installed / '.venv/bin/python')

    def test_installed_manifest_rejects_foreign_endpoint_and_public_permissions(self):
        installed, manifest = self.install_fixture()
        manifest.chmod(0o644)
        with self.assertRaises(ValueError):
            self.module.prepare_runtime(self.root)
        manifest.chmod(0o600)
        connection = installed / 'connection.json'
        value = json.loads(connection.read_text())
        value['url'] = 'https://untrusted.example'
        connection.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            self.module.prepare_runtime(self.root)

    def test_launchagent_delegates_to_the_owned_installer_without_mutating_runtime(self):
        with patch.object(self.module.sys, 'argv', ['personal_runtime.py', 'launchagent']), \
                patch.object(self.module.sys, 'platform', 'darwin'), \
                patch.object(self.module.Path, 'home', return_value=self.root), \
                patch.object(self.module, 'prepare_runtime') as prepare, \
                patch.object(self.module.subprocess, 'call', return_value=7) as call:
            self.assertEqual(self.module.main(), 7)
        prepare.assert_not_called()
        args = call.call_args.args[0]
        self.assertTrue(args[1].endswith('scripts/install-personal-macos.py'))
        self.assertEqual(args[2], 'install')


if __name__ == '__main__':
    unittest.main()
