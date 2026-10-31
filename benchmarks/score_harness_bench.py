import json,sys
from pathlib import Path
suite,task,workspace,out=sys.argv[1:]
suite=Path(suite)
sys.path.insert(0,str(suite/'src'))
sys.path.insert(0,str(suite/'tools/task_maintenance'))
from common import load_task_metadata,score_task_workspace
folder=suite/'tasks'/task
result=score_task_workspace(folder,load_task_metadata(folder/'task.yaml'),Path(workspace))
Path(out).write_text(json.dumps(result,indent=2)+'\n')
