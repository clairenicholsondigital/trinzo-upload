from pathlib import Path
import difflib, json, re, sys
case=Path(sys.argv[1]); output=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')); gold=json.loads((case/'manifest.json').read_text(encoding='utf-8'))
norm=lambda s: re.sub(r'[^a-z0-9]+',' ',(s or '').lower()).strip()
sim=lambda a,b: difflib.SequenceMatcher(None,norm(a),norm(b)).ratio()
def list_recall(expected, actual):
    if not expected: return 1.0 if not actual else 0.0
    return sum(max([sim(e,a) for a in actual] or [0])>=.60 for e in expected)/len(expected)
att=list_recall(gold.get('expected_attendees',[]),output.get('attendees',[]))
client=1.0 if {norm(x) for x in gold.get('expected_client_attendees',[])}=={norm(x) for x in output.get('client_attendees',[])} else 0.0
matched=0
for e in gold.get('expected_actions',[]):
    for a in output.get('actions',[]):
        if sim(e.get('owner'),a.get('owner'))>=.75 and sim(e.get('action'),a.get('action'))>=.55:
            matched+=1; break
action_recall=matched/max(1,len(gold.get('expected_actions',[])))
if not gold.get('expected_actions'): action_recall=1.0 if not output.get('actions') else 0.0
decision=list_recall(gold.get('expected_decisions',[]),output.get('decisions',[])); risk=list_recall(gold.get('expected_risks',[]),output.get('risks',[]))
score=100*(.15*att+.10*client+.45*action_recall+.15*decision+.15*risk)
print(json.dumps({'score':round(score,1),'attendee_recall':att,'client_split':client,'action_recall':action_recall,'decision_recall':decision,'risk_recall':risk,'note':'Baseline lexical-semantic proxy only. Review forbidden claims and due-date evidence manually.'},indent=2))
