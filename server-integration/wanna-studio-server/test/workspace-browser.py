import json,time,pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
result={'passed':[],'pageErrors':[]};client_id=None;stream_id=None
def mark(t):result['passed'].append(t);print('PASS '+t,flush=True)
def wait(page,fn,timeout=45000):
 deadline=time.monotonic()+timeout/1000
 while time.monotonic()<deadline:
  if fn():return
  page.wait_for_timeout(250)
 raise TimeoutError('Browser condition timed out')
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'])
 context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,permissions=['camera','microphone'])
 def page():
  tab=context.new_page();tab.on('pageerror',lambda e:result['pageErrors'].append(str(e)));return tab
 manager=page()
 def api(route,method='GET',data=None):return context.request.fetch('http://127.0.0.1:8801/api/workspace/'+route,method=method,**({'data':data} if data is not None else {}))
 try:
  manager.goto('http://127.0.0.1:8801/mobile/manage',wait_until='domcontentloaded')
  wait(manager,lambda:manager.locator('#connection').inner_text()=='מחובר לשרת')
  assert manager.evaluate('document.documentElement.scrollWidth<=innerWidth')
  manager.locator('#client-name').fill('__WANNA_QA__')
  manager.locator('#client-handle').fill('wanna_qa')
  manager.locator('#client-avatar').set_input_files(str(ROOT/'public/mobile/icon-512.png'))
  manager.locator('#client-form button[type=submit]').click()
  wait(manager,lambda:manager.locator('#client-progress').inner_text().find('נשמר')>=0)
  overview=api('overview').json();client=next(c for c in overview['clients'] if c['name']=='__WANNA_QA__');client_id=client['id']
  assert api('config').json()['mediaTools']
  mark('phone manager saved customer and actual avatar upload')
  manager.locator('[data-view=recipes]').click()
  manager.locator('#recipe-client').select_option(client_id)
  manager.locator('#recipe-title').fill('__QA_OVERLAY__')
  manager.locator('#recipe-media').select_option(client['avatarUrl'])
  manager.locator('#recipe-duration').fill('60')
  manager.locator('#recipe-form button').filter(has_text='שמור אפקט').click()
  wait(manager,lambda:manager.locator('#recipes-list').inner_text().find('__QA_OVERLAY__')>=0)
  mark('customer overlay saved through mobile editor')
  manager.screenshot(path=str(ROOT/'runtime/mobile-manager-preview.png'),full_page=True)
  manager.locator('[data-view=automations]').click()
  wait(manager,lambda:manager.locator('#rules-list .rule-row').count()>0)
  mark('original automation rules loaded in mobile manager')
  camera=page();camera.goto('http://127.0.0.1:8801/mobile/',wait_until='domcontentloaded');camera.locator('#start-camera-main').click()
  wait(camera,lambda:camera.evaluate("document.querySelector('#camera').readyState>=2 && document.querySelector('#camera-placeholder').hidden"))
  wait(camera,lambda:'מעקב פנים וגוף פעיל' in camera.locator('#tracking-state').inner_text(),90000)
  wait(camera,lambda:camera.locator('#personal-effects').inner_text().find('__QA_OVERLAY__')>=0)
  camera.locator('#personal-effects button').filter(has_text='__QA_OVERLAY__').click()
  wait(camera,lambda:camera.locator('#toast').inner_text().find('האישי פועל')>=0)
  mark('saved customer overlay reached live camera compositor')
  camera.locator('#send-server').click()
  wait(camera,lambda:any(s['state']=='running' and s['mode']=='preview' for s in api('overview').json()['broadcasts']))
  stream=next(s for s in reversed(api('overview').json()['broadcasts']) if s['state']=='running' and s['mode']=='preview');stream_id=stream['id']
  wait(camera,lambda:context.request.get('http://127.0.0.1:8801'+stream['playback']).status==200,60000)
  playlist=context.request.get('http://127.0.0.1:8801'+stream['playback']).text()
  assert '#EXTINF:' in playlist
  assert context.request.get('http://127.0.0.1:8801/api/workspace/broadcast/'+stream_id+'/files/init.mp4').status==200
  mark('continuous composed camera and audio reached FFmpeg and live HLS before stopping')
  viewer=page();viewer.goto('http://127.0.0.1:8801/mobile/viewer',wait_until='domcontentloaded')
  wait(viewer,lambda:viewer.locator('#stream option').count()>0)
  viewer.locator('#stream').select_option(stream_id);viewer.locator('#load-stream').click()
  wait(viewer,lambda:viewer.evaluate("document.querySelector('#server-video').readyState>=2"),45000)
  mark('separate server player decoded real phone-compositor stream')
  viewer.screenshot(path=str(ROOT/'runtime/mobile-server-preview.png'),full_page=True)
  camera.locator('#send-server').click()
  wait(camera,lambda:not camera.locator('#send-server').evaluate("e=>e.classList.contains('broadcast-on')"))
  camera.locator('#camera-toggle').click()
  mark('camera and continuous upload stop cleanly')
  assert not result['pageErrors'],result['pageErrors']
 except Exception as e:
  result['error']=str(e)
  try:manager.screenshot(path=str(ROOT/'runtime/mobile-workspace-failure.png'),full_page=True)
  except:pass
  raise
 finally:
  if stream_id:
   try:api('broadcast/'+stream_id+'/stop','POST')
   except:pass
  if client_id:
   try:api('clients/'+client_id,'DELETE')
   except:pass
  (ROOT/'runtime/mobile-workspace-browser-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
  print(json.dumps(result,ensure_ascii=True),flush=True)
  context.close();browser.close()
