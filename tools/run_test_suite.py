"""Record the Python regression suite as JSON plus a readable log."""
import io
import json
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
EVIDENCE = ROOT / ".runtime/test-evidence"
EVIDENCE.mkdir(parents=True, exist_ok=True)


class RecordedResult(unittest.TextTestResult):
    def startTest(self, test):
        self.started = time.perf_counter()
        super().startTest(test)

    def record(self, test, status, error=None):
        self.records.append({"id": test.id(), "status": status, "seconds": round(time.perf_counter() - self.started, 4), "error": error})

    def addSuccess(self, test):
        self.record(test, "PASS")
        super().addSuccess(test)

    def addFailure(self, test, error):
        self.record(test, "FAIL", self._exc_info_to_string(error, test))
        super().addFailure(test, error)

    def addError(self, test, error):
        self.record(test, "ERROR", self._exc_info_to_string(error, test))
        super().addError(test, error)

    def addSkip(self, test, reason):
        self.record(test, "SKIP", reason)
        super().addSkip(test, reason)

    def __init__(self, *args):
        super().__init__(*args)
        self.records = []


if __name__ == "__main__":
    stream = io.StringIO()
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
    result = unittest.TextTestRunner(stream=stream, verbosity=2, resultclass=RecordedResult).run(suite)
    (EVIDENCE / "backend-tests.log").write_text(stream.getvalue(), encoding="utf-8")
    data = {"total": result.testsRun, "passed": sum(row["status"] == "PASS" for row in result.records), "failed": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped), "results": result.records}
    (EVIDENCE / "backend-results.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Backend tests: {data['passed']}/{data['total']} passed, {data['failed']} failures, {data['errors']} errors.")
    raise SystemExit(0 if result.wasSuccessful() else 1)
