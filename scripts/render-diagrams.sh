#!/usr/bin/env bash
# Render all PlantUML diagrams (docs/diagrams/*.puml) -> PNG.
# Requires Java 21 + plantuml.jar (Maven: net.sourceforge.plantuml:plantuml).
# State/activity diagrams use "!pragma layout smetana" -> no Graphviz needed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../docs/diagrams" && pwd)"
JAR="${PLANTUML_JAR:-$HOME/plantuml.jar}"
if [ ! -f "$JAR" ]; then
  echo "plantuml.jar not found at $JAR"
  echo "Download: curl -sL https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/1.2025.10/plantuml-1.2025.10.jar -o \"$JAR\""
  exit 1
fi
fail=0
for f in "$DIR"/*.puml; do
  if java -jar "$JAR" -failfast2 -tpng "$f"; then echo "OK   $(basename "$f")"; else echo "FAIL $(basename "$f")"; fail=1; fi
done
exit $fail
