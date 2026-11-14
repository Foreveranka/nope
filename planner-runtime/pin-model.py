"""Refresh deliberately only after reviewing upstream; downloads metadata, never weights."""
import hashlib, json, pathlib, urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
MODEL='onnx-community/Qwen3-0.6B-ONNX-OPT'
REV='4799e655597b49210adb5c1ebe5b9d3bd04005a0'
meta=json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{MODEL}/revision/{REV}?blobs=true'))
files=[]
for name in ['config.json','generation_config.json','tokenizer.json','tokenizer_config.json','onnx/model_q4.onnx','onnx/model_q4.onnx_data']:
 item=next(s for s in meta['siblings'] if s['rfilename']==name)
 digest=item.get('lfs',{}).get('sha256')
 if not digest:
  data=urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{REV}/{name}').read()
  digest=hashlib.sha256(data).hexdigest()
 files.append({'path':name,'bytes':item['size'],'sha256':digest})
pack={'version':1,'id':MODEL,'revision':REV,'dtype':'q4','license':'Apache-2.0','runtime':{'package':'@huggingface/transformers','version':'4.3.2'},'totalBytes':sum(f['bytes'] for f in files),'files':files}
(ROOT/'model-pack.json').write_text(json.dumps(pack,indent=2)+'\n')
print(json.dumps(pack,indent=2))
