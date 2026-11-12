import os
BASE=os.environ.get("WANNA_TEST_URL", "http://127.0.0.1:18881").rstrip("/")
import json, time, pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
result={'passed':[], 'pageErrors':[], 'requestFailures':[]}
def wait_script(page, script, timeout=30000):
    deadline=time.monotonic()+timeout/1000
    while time.monotonic()<deadline:
        if page.evaluate("() => ("+script+")"): return
        page.wait_for_timeout(150)
    raise TimeoutError("Browser condition timed out: "+script)
def mark(name): result['passed'].append(name); print('PASS '+name,flush=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'])
    context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,permissions=['camera','microphone'])
    page=context.new_page()
    page.add_init_script("""window.__qaRecorders=[];const Base=MediaRecorder;window.MediaRecorder=class extends Base {constructor(stream,opts){super(stream,opts);this.qaStream=stream;window.__qaRecorders.push(this);}};""")
    page.on('pageerror',lambda e: result['pageErrors'].append(str(e)))
    page.on('requestfailed',lambda r: result['requestFailures'].append({'url':r.url.split('?')[0],'error':r.failure}))
    try:
        page.goto(BASE+'/mobile/',wait_until='domcontentloaded')
        wait_script(page, "document.querySelectorAll('#effects-list .effect').length>0")
        assert int(page.locator('#media-count').inner_text())>0
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
        mark('actual server catalog and effects loaded; mobile layout fits')
        page.locator('#start-camera-main').click()
        wait_script(page, "document.querySelector('#camera').readyState>=2 && document.querySelector('#camera-placeholder').hidden",timeout=20000)
        wait_script(page, "parseInt(document.querySelector('#fps').textContent)>0")
        mark('synthetic camera has live canvas output')
        page.locator('[data-tab=tests]').click()
        page.locator('#test-video').click()
        wait_script(page, "Number(document.querySelector('#ack-count').textContent)>0",timeout=15000)
        mark('canvas JPEG reached real server and was acknowledged')
        page.locator('#test-video').click()
        page.locator('#test-audio').click()
        wait_script(page, "!document.querySelector('#audio-echo').hidden",timeout=15000)
        assert page.locator('#audio-test-details').inner_text().find('KB')>=0
        mark('synthetic microphone sample reached server and echo is available')
        page.locator('#record').click()
        wait_script(page, "document.querySelector('#record').classList.contains('recording')")
        page.locator('#mic-toggle').click()
        assert not page.locator('#mic-toggle').evaluate("el=>el.classList.contains('active')")
        page.wait_for_timeout(1600)
        page.locator('#record').click()
        wait_script(page, "!document.querySelector('#recording-ready').hidden",timeout=15000)
        with page.expect_download() as download_info:
            page.locator('#download-recording').click()
        downloaded=download_info.value
        assert pathlib.Path(downloaded.path()).stat().st_size>1000
        mark('canvas recording produced nonempty media with audio; microphone mute toggles')
        wait_script(page, "document.querySelector('#tracking-state').textContent.includes('מעקב פנים וגוף פעיל')",timeout=90000)
        mark('original face/body engine initialized in Chromium')
        battle=page.request.get(BASE+'/api/battle').json()
        assert any(c['id']=='multiplier_x2' for c in battle['clips'])
        mark('existing glove video catalog is available')
        page.locator('[data-tab=effects]').click()
        page.locator('[data-screen=hits]').click()
        page.wait_for_timeout(800)
        assert page.locator('#toast').inner_text().find('הופעל')>=0
        mark('quick effect reached server and runs in original engine')
        page.screenshot(path=str(ROOT/'runtime'/'mobile-preview.png'),full_page=True)
        page.locator('#camera-toggle').click()
        assert page.evaluate("document.querySelector('#camera').srcObject===null && document.querySelector('#camera-placeholder').hidden===false")
        mark('camera and microphone stop')
        assert not result['pageErrors'],result['pageErrors']
    except Exception as e:
        result['error']=str(e)
        page.screenshot(path=str(ROOT/'runtime'/'mobile-failure.png'),full_page=True)
        raise
    finally:
        (ROOT/'runtime'/'mobile-browser-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=True),flush=True)
        context.close();browser.close()