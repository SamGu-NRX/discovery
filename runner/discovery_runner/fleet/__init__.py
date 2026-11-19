"""The operator: reads Sam's T3 fleet from T3's own database and turns abnormal run ends into cards.

Reads go to T3's SQLite database, opened read-only (probe.py). Writes, meaning a card posted to the
Operator thread or a launched thread, go through T3's MCP endpoint, and only launcher.py may make them.
See runner/README.md, "Fleet".
"""
