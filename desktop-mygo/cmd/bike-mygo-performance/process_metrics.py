"""Same macOS RSS and CPU accounting for both benchmark hosts."""
import ctypes
import json
import os
import subprocess
import sys
import time

main_pid = int(sys.argv[1])
known = json.loads(sys.argv[2])
library = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
responsible = library.responsibility_get_pid_responsible_for_pid
responsible.argtypes = [ctypes.c_int]
responsible.restype = ctypes.c_int

class Usage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_ubyte * 16)] + [(name, ctypes.c_uint64) for name in [
        'user_ticks', 'system_ticks', 'package_idle_wakeups', 'interrupt_wakeups',
        'pageins', 'wired_bytes', 'resident_bytes', 'physical_footprint_bytes',
        'process_start', 'process_exit', 'child_user_ns', 'child_system_ns',
        'child_package_idle_wakeups', 'child_interrupt_wakeups', 'child_pageins',
        'child_elapsed_ns', 'disk_read_bytes', 'disk_write_bytes']]

usage = library.proc_pid_rusage
usage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
usage.restype = ctypes.c_int

class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]

timebase = Timebase()
library.mach_timebase_info(ctypes.byref(timebase))
seconds_per_tick = timebase.numer / timebase.denom / 1e9
rows = []
raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,rss=,comm='], text=True)
for line in raw.splitlines():
    parts = line.strip().split(None, 3)
    if len(parts) == 4:
        pid, parent, rss = map(int, parts[:3])
        if pid != os.getpid() and parent != os.getpid():
            rows.append(dict(pid=pid, parentPid=parent, rssBytes=rss * 1024, executable=parts[3]))
selected = {main_pid: 'main'}
for role, pids in known.items():
    for pid in pids:
        if pid > 0 and pid != main_pid:
            selected[pid] = role
for row in rows:
    row['responsiblePid'] = responsible(row['pid'])
    if row['responsiblePid'] == main_pid and row['pid'] not in selected:
        name = row['executable']
        role = 'network' if 'WebKit.Networking' in name else 'gpu' if 'WebKit.GPU' in name else 'webContent' if 'WebKit.WebContent' in name else 'attributedHelper'
        selected[row['pid']] = role
for _ in range(4):
    for row in rows:
        if row['parentPid'] in selected and row['pid'] not in selected and not row['executable'].endswith(('python3', '/ps')):
            selected[row['pid']] = 'descendantHelper'
processes = []
for row in rows:
    if row['pid'] not in selected:
        continue
    row['role'] = selected[row['pid']]
    info = Usage()
    if usage(row['pid'], 2, ctypes.byref(info)) == 0:
        row.update(cpuSeconds=(info.user_ticks + info.system_ticks) * seconds_per_tick, packageIdleWakeups=info.package_idle_wakeups, interruptWakeups=info.interrupt_wakeups, physicalFootprintBytes=info.physical_footprint_bytes)
    processes.append(row)
unattributed = [dict(pid=row['pid'], responsiblePid=row['responsiblePid'], rssBytes=row['rssBytes']) for row in rows if 'WebKit.Networking' in row['executable'] and row['pid'] not in selected]
result = dict(timestamp=time.time(), mainPid=main_pid, processes=processes, totalRssBytes=sum(row['rssBytes'] for row in processes), unattributedSystemNetworkProcesses=unattributed, accounting='ps RSS, known page/GPU PIDs plus libSystem responsibility and app descendants; sum counts shared pages in each process', networkAttribution='responsibility_get_pid_responsible_for_pid; shared processes owned by another app cannot be apportioned')
if len(sys.argv) > 3:
    controller_pid = int(sys.argv[3])
    result['externalController'] = next((row for row in rows if row['pid'] == controller_pid), None)
    result['externalControllerAccounting'] = 'separate RSS diagnostic, excluded from app total; Node LiveStore client runs here for Electron, Go LiveStore client runs in native main'
print(json.dumps(result))
