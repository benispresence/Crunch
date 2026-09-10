"""Authenticated engine-owned subprocess jobs, recoverable across API restarts."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid


class PipelineJobs:
    def __init__(self, root):
        self.root = Path(root)
        self.directory = Path(os.environ.get('CRUNCH_PIPELINE_JOB_DIR', str(Path(tempfile.gettempdir()) / 'crunch-engine-jobs')))
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.children = {}
        self.secrets = {}

    def path(self, job_id):
        if not re.fullmatch(r'[a-zA-Z0-9-]{16,100}', job_id):
            raise ValueError('invalid job ID')
        return self.directory / job_id

    def submit(self, job):
        job_id = job.get('job_id') or str(uuid.uuid4())
        directory = self.path(job_id)
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            return {'job_id': job_id, **self.status(job_id)}
        job.setdefault('runtime_config', {})['state_dir'] = str(self.directory / 'state')
        path = directory / 'job.json'
        path.write_text(json.dumps(job))
        path.chmod(0o600)
        self.secrets[job_id] = job.get('environment_secrets') or []
        log = open(directory / 'process.log', 'wb')
        proc = subprocess.Popen([sys.executable, '-m', 'crunch.pipelines.runner', str(path)],
            cwd=self.root, env={**os.environ, 'PYTHONPATH': str(self.root / 'src') + os.pathsep + os.environ.get('PYTHONPATH', '')},
            start_new_session=True, stdout=log, stderr=log)
        log.close()
        self.children[job_id] = proc
        (directory / 'meta.json').write_text(json.dumps({'pid': proc.pid, 'started': time.time(), 'timeout': job.get('timeout_seconds', 1800)}))
        def supervise():
            try:
                proc.wait(timeout=job.get('timeout_seconds', 1800) + 10)
            except subprocess.TimeoutExpired:
                self.kill(proc)
                (directory / 'timed_out').touch()
            finally:
                log_path = directory / 'process.log'
                output = log_path.read_text(errors='replace')
                for secret in sorted(filter(None, self.secrets.get(job_id, [])), key=len, reverse=True):
                    output = output.replace(secret, '[REDACTED]')
                log_path.write_text(output)
                self.secrets.pop(job_id, None)
                path.unlink(missing_ok=True)
        threading.Thread(target=supervise, daemon=True).start()
        return {'job_id': job_id, 'status': 'running'}

    def kill(self, proc):
        if proc.poll() is not None:
            return
        if os.name == 'nt':
            proc.kill()
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        proc.wait(timeout=5)

    def cancel(self, job_id):
        directory = self.path(job_id)
        proc = self.children.get(job_id)
        if proc is None and not (directory / 'job.json.result.json').exists():
            return {'status': 'interrupted', 'error': 'Worker ownership lost; cancellation cannot be verified'}
        if proc:
            self.kill(proc)
        (directory / 'cancelled').touch()
        return {'status': 'cancelled', 'pid_alive': False}

    def status(self, job_id):
        directory = self.path(job_id)
        if not directory.exists():
            return {'status': 'interrupted'}
        if (directory / 'cancelled').exists():
            return {'status': 'cancelled'}
        result = directory / 'job.json.result.json'
        if result.exists():
            try:
                return {'status': 'finished', 'result': json.loads(result.read_text())}
            except json.JSONDecodeError:
                return {'status': 'running'}
        proc = self.children.get(job_id)
        if proc and proc.poll() is None:
            return {'status': 'running'}
        if proc:
            log = (directory / 'process.log').read_text(errors='replace')
            for secret in sorted(filter(None, self.secrets.get(job_id, [])), key=len, reverse=True):
                log = log.replace(secret, '[REDACTED]')
            log = log[-20000:]
            return {'status': 'finished', 'result': {'success': False, 'error': 'Worker timed out' if (directory / 'timed_out').exists() else f'Worker exited {proc.returncode}', 'log': log, 'rows_loaded': 0}}
        # Engine restart: do not signal arbitrary persisted PIDs or replay writes.
        return {'status': 'interrupted'}
