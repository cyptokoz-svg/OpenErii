#!/bin/bash
# ATLAS Extension Quality Metrics
# Run: bash scripts/atlas-metrics.sh

cd "$(dirname "$0")/.."

ATLAS_DIR="src/extension/atlas"
DATA_DIR="data/atlas"
UI_DIR="ui/src"

# ==================== File counts ====================
atlas_files=$(find $ATLAS_DIR -name "*.ts" -o -name "*.tsx" 2>/dev/null | wc -l | tr -d ' ')
prompt_files=$(find $DATA_DIR -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
test_files=$(find $ATLAS_DIR -name "*.spec.ts" -o -name "*.test.ts" 2>/dev/null | wc -l | tr -d ' ')
ui_files=$(find $UI_DIR -path "*atlas*" -o -path "*Atlas*" -o -path "*i18n*" 2>/dev/null | grep -c "\.tsx\|\.ts" || echo 0)

# ==================== Code quality ====================
total_lines=0
type_any=0
todo_count=0
long_functions=0

if [ -d "$ATLAS_DIR" ]; then
  total_lines=$(find $ATLAS_DIR -name "*.ts" -exec cat {} + 2>/dev/null | wc -l | tr -d ' ')

  # Count 'any' type usage (bad practice)
  type_any=$(find $ATLAS_DIR -name "*.ts" ! -name "*.spec.ts" -exec grep -c ": any\|as any\|<any>" {} + 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')

  # Count TODOs
  todo_count=$(find $ATLAS_DIR -name "*.ts" -exec grep -ci "TODO\|FIXME\|HACK\|XXX" {} + 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')

  # Count long functions (>50 lines)
  long_functions=$(find $ATLAS_DIR -name "*.ts" ! -name "*.spec.ts" -exec awk '
    /^[[:space:]]*(async )?function |^[[:space:]]*(async )?[a-zA-Z]+\(.*\)[[:space:]]*[:{]/ { start=NR; brace=0 }
    /{/ { brace++ }
    /}/ { brace--; if(brace==0 && start>0) { if(NR-start>50) count++; start=0 } }
    END { print count+0 }
  ' {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')
fi

# ==================== TypeScript compilation ====================
compile_errors=0
if [ -f "tsconfig.json" ] && [ -d "$ATLAS_DIR" ]; then
  compile_errors=$(npx tsc --noEmit 2>&1 | grep -c "error TS" || true)
  compile_errors=${compile_errors//[^0-9]/}
  compile_errors=${compile_errors:-0}
fi

# ==================== Tests ====================
test_pass=0
test_fail=0
test_total=0
if [ "$test_files" -gt 0 ]; then
  test_output=$(npx vitest run --reporter=json $ATLAS_DIR 2>&1 || true)
  test_pass=$(echo "$test_output" | tr ',' '\n' | grep '"numPassedTests"' | head -1 | grep -o '[0-9]*' || echo 0)
  test_fail=$(echo "$test_output" | tr ',' '\n' | grep '"numFailedTests"' | head -1 | grep -o '[0-9]*' || echo 0)
  test_pass=${test_pass:-0}
  test_fail=${test_fail:-0}
  test_total=$((test_pass + test_fail))
fi

# ==================== Health score ====================
# Weighted: compilation(40) + type_safety(20) + no_long_functions(15) + tests(15) + no_todos(10)
compile_score=0
if [[ "$compile_errors" -eq 0 && "$total_lines" -gt 0 ]]; then compile_score=40; fi

type_score=20
if [ "$total_lines" -gt 0 ] && [ "$type_any" -gt 0 ]; then
  any_pct=$((type_any * 100 / (total_lines + 1)))
  type_score=$((20 - any_pct))
  if [ "$type_score" -lt 0 ]; then type_score=0; fi
fi

func_score=15
if [ "$long_functions" -gt 0 ]; then
  func_score=$((15 - long_functions * 3))
  if [ "$func_score" -lt 0 ]; then func_score=0; fi
fi

test_score=0
if [ "$test_total" -gt 0 ]; then
  test_score=$((15 * test_pass / test_total))
fi

todo_score=10
if [ "$todo_count" -gt 5 ]; then
  todo_score=$((10 - (todo_count - 5)))
  if [ "$todo_score" -lt 0 ]; then todo_score=0; fi
fi

health_score=$((compile_score + type_score + func_score + test_score + todo_score))

# ==================== Output ====================
echo "atlas_files=$atlas_files"
echo "prompt_files=$prompt_files"
echo "test_files=$test_files"
echo "ui_files=$ui_files"
echo "total_lines=$total_lines"
echo "compile_errors=$compile_errors"
echo "type_any=$type_any"
echo "long_functions=$long_functions"
echo "todo_count=$todo_count"
echo "test_pass=$test_pass"
echo "test_fail=$test_fail"
echo "test_total=$test_total"
echo "health_score=$health_score"
