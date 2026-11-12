import os,json,pathlib,time
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('WANNA_TEST_URL','http://127.0.0.1:18881')
ROOT=pathlib.Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(viewport={'width':390,'height':844})
 page.add_init_script("""window.qaSpeech=[];Object.defineProperty(window,'speechSynthesis',{value:{pending:false,cancel(){},speak(u){window.qaSpeech.push(u.text)}}});""")
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 state={'status':'connected','handle':'qa_creator','battle':{'id':'qa-round','status':'active','endTimeMs':int(time.time()*1000)+240000,'scores':[{'id':'11','score':'1250'},{'id':'22','score':'980'}]},'participants':[{'id':'11','name':'QA Host'},{'id':'22','name':'QA Opponent'}]}
 page.route('**/api/workspace/tiktok',lambda route:route.fulfill(json=state))
 state['roomId']='qa-room'
 state['chat']=[{'id':1,'at':int(time.time()*1000),'user':{'name':'QA Viewer'},'text':'שלום <img src=x onerror=alert(1)>'}]
 state['events']=[{'id':2,'at':int(time.time()*1000),'type':'gift','name':'Rose','count':3,'user':{'name':'QA Gifter'}}]
 state['viewers']=12
 try:
  page.goto(BASE+'/mobile/')
  panel=page.locator('#live-battle')
  panel.get_by_text('QA Opponent',exact=True).wait_for()
  assert panel.locator('[data-scores]').inner_text().find('1250')>=0
  assert 'שניות' in panel.locator('[data-clock]').inner_text()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  expect(panel.locator('[data-chat]')).to_contain_text('QA Viewer')
  expect(panel.locator('[data-chat]')).to_contain_text('<img src=x onerror=alert(1)>')
  assert panel.locator('[data-chat] img').count()==0
  assert not panel.locator('[data-read-chat]').is_checked()
  assert page.evaluate('window.qaSpeech.length')==0
  panel.locator('[data-read-chat]').check()
  state['chat'].insert(0,{'id':3,'at':int(time.time()*1000),'user':{'name':'QA Viewer'},'text':'הודעה חדשה'})
  expect(panel.locator('[data-chat]')).to_contain_text('הודעה חדשה')
  assert page.evaluate('window.qaSpeech.length')==1
  assert panel.locator('[data-watch]').get_attribute('href')=='https://www.tiktok.com/@qa_creator/live'
  page.screenshot(path=str(ROOT/'runtime/battle-preview.png'),full_page=True)
  state['battle']['status']='ended'
  expect(panel.locator("[data-clock]")).to_have_text("הסתיים")
  state['status']='disconnected'
  expect(panel.locator("[data-scores] > div")).to_have_count(0)
  expect(panel.locator('[data-chat] > div')).to_have_count(0)
  state['status']='connected';state['roomId']='new-room';state['chat']=[]
  expect(panel.locator('[data-chat-status]')).to_contain_text('ממתין להודעה הראשונה')
  assert page.evaluate('window.qaSpeech.length')==1
  assert not errors,errors
  print('PASS mobile chat, safe text rendering, optional speech only for new messages, room reset, battle scores/countdown and disconnected state; controlled telemetry only',flush=True)
 finally:browser.close()
