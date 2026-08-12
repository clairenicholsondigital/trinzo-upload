from pathlib import Path
import json, sys
root=Path(__file__).resolve().parents[1]
errors=[]
case_dirs=sorted((root/'cases').iterdir())
if len(case_dirs)!=10: errors.append(f'expected 10 cases, found {len(case_dirs)}')
ids=[]
for d in case_dirs:
    for name in ('transcript.docx','manifest.json','gold_minutes.md'):
        if not (d/name).is_file(): errors.append(f'{d.name}: missing {name}')
    try:
        m=json.loads((d/'manifest.json').read_text(encoding='utf-8')); ids.append(m['case_id'])
        for key in ('schema_version','case_slug','test_focus','expected_attendees','expected_actions','forbidden_claims'):
            if key not in m: errors.append(f'{d.name}: missing manifest key {key}')
    except Exception as e: errors.append(f'{d.name}: invalid manifest: {e}')
if sorted(ids)!=list(range(1,11)): errors.append(f'case ids are {sorted(ids)}, expected 1..10')
if errors:
    print('\n'.join('ERROR: '+e for e in errors)); sys.exit(1)
print(f'PASS: {len(case_dirs)} cases and {len(list((root/"human_benchmarks").iterdir()))} human benchmarks validated')
