"""Golden cases for the world's edit engine, from nontainer's.

Usage: python scripts/golden-editing.py PATH/TO/nontainer/editing.py > tests/fixtures/golden-editing.json

Loads nontainer's ``editing.py`` (standard library only) and records,
for each case, what ``apply_edit`` returns or the message it raises.
"""

import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("editing", sys.argv[1])
editing = importlib.util.module_from_spec(spec)
sys.modules["editing"] = editing
spec.loader.exec_module(editing)

PY = """def f(x):
    if x:
        return 1
    return 2


def g():
    pass
"""

TABS = "class A:\n\tdef m(self):\n\t\tif ok:\n\t\t\trun()\n\t\treturn 1\n"

LONG = "\n".join(f"line {i}: value = {i * 7}" for i in range(40)) + "\n"

CASES = [
    ("exact once", PY, "return 2", "return 3", False),
    ("exact, ambiguous", "a\na\n", "a", "b", False),
    ("exact, replace_all", "a\na\nb\n", "a", "c", True),
    ("replacement kept literal", "x = 1\n", "x = 1", "x = r'\\1 $& \\\\'", False),
    ("trailing whitespace in the file", "one  \ntwo\t\nthree\n", "one\ntwo", "ONE\nTWO", False),
    ("trailing whitespace, ambiguous", "a \nb\na  \nb\n", "a\nb", "c", False),
    ("trailing whitespace, replace_all", "a \nb\na  \nb\n", "a\nb", "c", True),
    ("indent: quote dedented", PY, "if x:\n    return 1", "if x:\n    return 10\n# done", False),
    ("indent: quote over-indented", PY, "        if x:\n            return 1", "        if not x:\n            return 0", False),
    ("indent: tabs in the file", TABS, "if ok:\n    run()", "if ok:\n    run()\n    log()", False),
    ("indent: first line indented on its own", PY, "if x:\n            return 1\n        return 2", "if y:\n            return 1\n        return 2", False),
    ("indent: insert above the head", PY, "if x:\n            return 1\n        return 2", "print(x)\nif x:\n            return 1\n        return 2", False),
    ("indent: shifted unevenly is no match", PY, "if x:\nreturn 1\n  return 2", "z", False),
    ("indent: ambiguous", "  a\n  b\n    a\n    b\n", "a\nb", "c\nd", False),
    ("indent: replace_all", "  a\n  b\n    a\n    b\n", "a\nb", "c\nd", True),
    ("indent: crlf file", "def f():\r\n    a = 1\r\n    b = 2\r\n", "a = 1\nb = 2", "a = 3\nb = 4", False),
    ("already applied", PY, "return 99", "return 1", False),
    ("not found, similar lines", LONG, "line 20: value = 141\nline 21: value = 148", "x", False),
    ("not found, nothing similar", PY, "completely unrelated text here", "qqqq", False),
    ("not found, long search", PY, "zzz " * 80, "qqqq", False),
    ("identical strings", PY, "return 2", "return 2", False),
    ("blank-only quote", PY, "   \n  ", "x", False),
]

out = []
for name, content, old, new, replace_all in CASES:
    case = {"name": name, "content": content, "old": old, "new": new, "replace_all": replace_all}
    try:
        r = editing.apply_edit(content, old, new, replace_all=replace_all, path="f.py")
        case["result"] = {"content": r.content, "count": r.count, "mode": r.mode}
    except editing.EditError as e:
        case["error"] = str(e)
    out.append(case)

ratios = [
    ["abcd", "bcde"],
    ["the quick brown fox", "the quick brown dog"],
    ["", "abc"],
    ["x" * 250 + "abc", "x" * 240 + "abd" + "y" * 30],
    ["def f(x):\n    return x", "def g(y):\n    return y + 1"],
]
json.dump(
    {
        "cases": out,
        "ratios": [{"a": a, "b": b, "ratio": editing.SequenceMatcher(None, a, b).ratio()} for a, b in ratios],
    },
    sys.stdout,
    indent=1,
    ensure_ascii=False,
)
print()
