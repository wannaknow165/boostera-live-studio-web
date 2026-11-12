import os,json,pathlib,time
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('WANNA_TEST_URL','http://127.0.0.1:18881')
ROOT=pathlib.Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(viewport={'width':390,'height':844})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 state={'status':'connected','handle':'qa_creator','battle':{'id':'qa-round','status':'active','endTimeMs':int(time.time()*1000)+240000,'scores':[{'id':'11','score':'1250'},{'id':'22','score':'980'}]},'participants':[{'id':'11','name':'QA Host'},{'id':'22','name':'QA Opponent'}]}
 page.route('**/api/workspace/tiktok',lambda route:route.fulfill(json=state))
 try:
  page.goto(BASE+'/mobile/')
  panel=page.locator('#live-battle')
  panel.get_by_text('QA Opponent',exact=True).wait_for()
  assert panel.locator('[data-scores]').inner_text().find('1250')>=0
  assert 'שניות' in panel.locator('[data-clock]').inner_text()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  assert panel.locator('[data-watch]').get_attribute('href')=='https://www.tiktok.com/@qa_creator/live'
  page.screenshot(path=str(ROOT/'runtime/battle-preview.png'),full_page=True)
  state['battle']['status']='ended'
  expect(panel.locator("[data-clock]")).to_have_text("הסתיים")
  state['status']='disconnected'
  expect(panel.locator("[data-scores] > div")).to_have_count(0)
  assert not errors,errors
  print('PASS battle panel renders participants, exact scores, countdown, end, disconnect and correct viewing link from controlled telemetry; no real battle asserted',flush=True)
 finally:browser.close()
