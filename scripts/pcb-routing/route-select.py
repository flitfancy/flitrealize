"""Conflict-free complete-route selection; does not route or write EDA."""
import json,sys,time,math
from ortools.sat.python import cp_model

def solve(data):
 if data.get('kind')!='flitrealize.route-conflict-graph':raise ValueError('ROUTE_GRAPH_REQUIRED')
 options=data['settings'];vs=data['variants'];model=cp_model.CpModel();choose=[model.new_bool_var('v'+str(v['id'])) for v in vs];connected={}
 for net,ids in data['byNet'].items():
  flag=model.new_bool_var(net);model.add(sum(choose[i] for i in ids)==flag);connected[net]=flag
  if net in options['forceNets']:model.add(flag==1)
 for a,b in data['conflicts']:model.add(choose[a]+choose[b]<=1)
 costs=[round(v['viaCount']*options['viaWeight']+v['lengthMm']*options['lengthWeight']) for v in vs]
 if any(c<0 for c in costs) or any(not math.isfinite(c) for c in costs):raise ValueError('INVALID_ROUTE_SELECTION_COST')
 dominance=sum(costs)+1;model.minimize(sum(choose[i]*c for i,c in enumerate(costs))-dominance*sum(connected.values()))
 solver=cp_model.CpSolver();solver.parameters.max_time_in_seconds=options['maxSeconds'];solver.parameters.num_search_workers=options['workers'];began=time.time();status=solver.solve(model)
 result={'status':solver.status_name(status),'wallSeconds':time.time()-began,'nativeWrites':0,'optimalForAvailableVariants':status==cp_model.OPTIMAL}
 if status in [cp_model.FEASIBLE,cp_model.OPTIMAL]:
  selected=[v for v in vs if solver.value(choose[v['id']])];result.update(selectedIds=[v['id'] for v in selected],connected=len(selected),remaining=[n for n,f in connected.items() if not solver.value(f)],viaCount=sum(v['viaCount'] for v in selected),lengthMm=sum(v['lengthMm'] for v in selected))
 return result

if __name__=='__main__':
 try:print(json.dumps(solve(json.load(sys.stdin))))
 except Exception as error:print(json.dumps({'error':str(error)}),file=sys.stderr);sys.exit(2)
