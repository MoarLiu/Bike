import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILD = os.environ.get('BIKE_MYGO_BUILD', '1')
CHANNEL = os.environ.get('BIKE_MYGO_CHANNEL', 'preview')
CANDIDATE = ROOT / f'release/mygo/2.0.0/build-{BUILD}-{CHANNEL}'
ELECTRON = pathlib.Path(os.environ.get('BIKE_ELECTRON_APP', str(ROOT / 'release/mac-arm64/Bike.app')))
EVIDENCE = pathlib.Path(os.environ.get(
    'BIKE_MYGO_LIFECYCLE_EVIDENCE',
    str(ROOT / 'docs/evidence-mygo-2026-11-11-integration/shipping-lifecycle'),
))
EVIDENCE.mkdir(parents=True, exist_ok=True)
manifest = json.loads((CANDIDATE / 'build-manifest.json').read_text())
processes = []
logs = []
report = {
    'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'build': BUILD,
    'sourceFingerprint': manifest['sourceFingerprint'],
    'frontendSHA256': manifest['frontendSHA256'],
    'checks': {},
    'limitations': [
        'One current macOS host and isolated profiles, physical macOS 12/13 and a second device remain pending.',
        'Window restoration is verified from an explicit persisted window.json fixture. Interactive move/resize and Dock/close-window reopening remain separate UI checks.',
        'Abnormal exit is an intentional SIGKILL of the isolated idle shipping MyGO process. This does not establish interrupted-write recovery.',
        'Quit timing covers idle shipping application AppleEvent request through natural process exit.',
    ],
}


def run(arguments, **options):
    return subprocess.run(arguments, capture_output=True, text=True, check=True, **options)


def spawn(binary, env, name):
    log = (EVIDENCE / (name + '.log')).open('w')
    logs.append(log)
    child = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=subprocess.STDOUT)
    processes.append(child)
    return child


def stop(process):
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)


with tempfile.TemporaryDirectory(prefix='bike-mygo-shipping-lifecycle-') as folder:
    temporary = pathlib.Path(folder)
    metadata = temporary / 'window-metadata'
    run(['/usr/bin/swiftc', str(pathlib.Path(__file__).with_suffix('.swift')), '-o', str(metadata)])
    mygo_app = temporary / 'mygo' / pathlib.Path(manifest['bundle']).name
    electron_app = temporary / 'electron/Bike.app'
    run(['/usr/bin/ditto', '--norsrc', str(ROOT / manifest['bundle']), str(mygo_app)])
    run(['/usr/bin/ditto', '--norsrc', str(ELECTRON), str(electron_app)])
    run(['/usr/bin/codesign', '--verify', '--strict', str(mygo_app)])
    mygo_binary = mygo_app / 'Contents/MacOS/bike-mygo'
    electron_binary = electron_app / 'Contents/MacOS/Bike'
    assert hashlib.sha256(mygo_binary.read_bytes()).hexdigest() == manifest['binarySHA256']
    home = temporary / 'home'
    home.mkdir()
    go_profile = home / 'Library/Application Support/Bike-MyGO-preview'
    go_profile.mkdir(parents=True)
    electron_profile = temporary / 'electron-profile'
    desired = {'X': 20, 'Y': 30, 'Width': 1600, 'Height': 1000}
    window_file = go_profile / 'window.json'
    window_file.write_text(json.dumps(desired))
    mygo_env = {
        **os.environ, 'HOME': str(home), 'CFFIXED_USER_HOME': str(home),
        'PATH': '/usr/bin:/bin', 'MYGO_ENV': 'development',
    }
    electron_env = {
        **os.environ, 'HOME': str(home), 'CFFIXED_USER_HOME': str(home),
        'BIKE_TEST_USER_DATA': str(electron_profile),
        'VITE_DEV_SERVER_URL': '', 'ELECTRON_RUN_AS_NODE': '',
    }

    def windows(process):
        values = json.loads(run([str(metadata), str(process.pid)]).stdout)
        return [item for item in values if item.get('kCGWindowLayer') == 0
                and item.get('kCGWindowBounds', {}).get('Width', 0) >= 1200]

    def wait_window(process):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and process.poll() is None:
            result = windows(process)
            if result:
                return result[0]
            time.sleep(0.1)
        raise AssertionError(f'No shipping window for {process.pid}')

    def graceful(process, app):
        start = time.monotonic()
        answer = subprocess.run([
            '/usr/bin/osascript', '-e', 'tell application ' + json.dumps(str(app)) + ' to quit',
        ], capture_output=True, text=True, timeout=10)
        code = process.wait(timeout=20)
        assert code == 0, code
        return {'naturalExit': True, 'status': code, 'durationMs': (time.monotonic() - start) * 1000,
                'appleEventStatus': answer.returncode, 'appleEventError': answer.stderr.strip()}

    try:
        identity = json.loads(run([str(mygo_binary), '--version'], env=mygo_env).stdout)
        assert identity['build'] == BUILD
        report['identity'] = identity
        assert subprocess.run(['/usr/bin/env', 'node', '--version'], env={'PATH': '/usr/bin:/bin'}, capture_output=True).returncode != 0
        go_process = spawn(mygo_binary, mygo_env, 'mygo-first')
        go_window = wait_window(go_process)
        electron_process = spawn(electron_binary, electron_env, 'electron-first')
        electron_window = wait_window(electron_process)
        time.sleep(1)
        assert go_process.poll() is None and electron_process.poll() is None
        report['checks']['coexistingShippingWindows'] = True
        report['initialWindows'] = {'mygo': go_window, 'electron': electron_window}
        bounds = go_window['kCGWindowBounds']
        assert bounds['Width'] == desired['Width'] and bounds['Height'] == desired['Height'], bounds
        report['checks']['persistedWindowDimensionsRestored'] = True
        report['requestedWindowBounds'] = desired
        for process, label in [(go_process, 'mygo'), (electron_process, 'electron')]:
            current = wait_window(process)
            capture = subprocess.run(['/usr/sbin/screencapture', '-x', '-l', str(current['kCGWindowNumber']), str(EVIDENCE / (label + '-coexisting.png'))], capture_output=True)
            assert capture.returncode == 0
        for label, binary, environment, original in [
            ('mygo', mygo_binary, mygo_env, go_process),
            ('electron', electron_binary, electron_env, electron_process),
        ]:
            second = spawn(binary, environment, label + '-second')
            assert second.wait(timeout=15) == 0
            time.sleep(0.2)
            assert original.poll() is None
            current = windows(original)
            assert len(current) == 1, current
            report['checks'][label + 'SecondInstanceExitedWithoutExtraWindow'] = True
        assert go_profile.is_dir() and electron_profile.is_dir()
        assert go_profile.resolve() != electron_profile.resolve()
        report['checks']['independentProfileDirectories'] = True
        go_process.kill()
        assert go_process.wait(timeout=5) == -9
        assert electron_process.poll() is None and len(windows(electron_process)) == 1
        report['checks']['electronSurvivedMygoAbnormalExit'] = True
        go_process = spawn(mygo_binary, mygo_env, 'mygo-restart')
        restarted = wait_window(go_process)
        report['restartedWindow'] = restarted
        assert restarted['kCGWindowBounds']['Width'] == desired['Width']
        assert restarted['kCGWindowBounds']['Height'] == desired['Height']
        report['checks']['mygoRestartedWithPersistedDimensions'] = True
        report['mygoQuit'] = graceful(go_process, mygo_app)
        assert electron_process.poll() is None and len(windows(electron_process)) == 1
        report['checks']['electronSurvivedMygoNaturalQuit'] = True
        report['electronQuit'] = graceful(electron_process, electron_app)
        report['checks']['nodeFreeMygoCLIAndGUI'] = True
        report['complete'] = True
    finally:
        for process in processes:
            stop(process)
        report['ownedMainProcessesExited'] = all(process.poll() is not None for process in processes)
        report['temporaryProfilesRemovedOnExit'] = True
        (EVIDENCE / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        for log in logs:
            log.close()
print(json.dumps(report, ensure_ascii=False, indent=2))
