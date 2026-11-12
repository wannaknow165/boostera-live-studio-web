"""Local synthetic DOM/HTTP regression. Does not contact TikTok or start a LIVE."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EXPORT = "import {nativeBattleDocument,battleActions} from './src/battles.mjs'; console.log(JSON.stringify({source:nativeBattleDocument.toString(),actions:Object.keys(battleActions)}))"
adapter = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', EXPORT], cwd=ROOT, text=True, encoding='utf-8'))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 430, 'height': 932})
    def inspect(command=None):
        return page.evaluate('([source, actions, command]) => (0,eval)("("+source+")")(actions, command)', [adapter['source'], adapter['actions'], command])
    page.set_content('''<div data-ix-state="match.invitation" data-ix-battle-id="456" data-ix-channel-id="789" data-ix-invitation-role="invitee">
      <button data-ix-action="match.accept" onclick="window.accepts=(window.accepts||0)+1">Accept</button>
      <button data-ix-action="match.decline">Decline</button></div>''')
    initial = inspect()
    assert {x['action'] for x in initial['buttons']} == {'match.accept', 'match.decline'}
    assert inspect({'action': 'match.accept', 'identity': initial['identity']})['clicked']
    assert page.evaluate('window.accepts') == 1
    # A hidden duplicate must not shadow the one visible native control.
    page.locator('[data-ix-action="match.accept"]').evaluate('(e)=>{const hidden=e.cloneNode(true);hidden.style.display="none";e.before(hidden);}')
    observed = inspect()
    assert inspect({'action': 'match.accept', 'identity': observed['identity']})['clicked']
    assert page.evaluate('window.accepts') == 2
    page.locator('[data-ix-action="match.accept"]').first.evaluate('(e)=>e.remove()')
    # Electron reports hidden when minimized. Rendered original controls remain
    # actionable without bringing the window forward; CSS-hidden controls do not.
    page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'})")
    minimized = inspect()
    assert minimized['ready'] and next(x for x in minimized['buttons'] if x['action']=='match.accept')['enabled']
    page.locator('[data-ix-action="match.accept"]').evaluate('(e)=>e.style.display="none"')
    assert 'match.accept' not in [x['action'] for x in inspect()['buttons']]
    page.locator('[data-ix-action="match.accept"]').evaluate('(e)=>e.style.display=""')
    # No foreground APIs or keyboard/mouse injection are involved in a dispatch.
    page.evaluate('() => {window.focus=()=>{throw new Error("unexpected foreground activation")}; HTMLElement.prototype.focus=()=>{throw new Error("unexpected input focus")};}')
    observed = inspect()
    assert inspect({'action': 'match.accept', 'identity': observed['identity']})['clicked']
    page.locator('[data-ix-state]').evaluate('(e)=>e.setAttribute("data-ix-battle-id","999")')
    assert inspect({'action': 'match.accept', 'identity': initial['identity']})['error'] == 'BATTLE_CHANGED'
    page.locator('[data-ix-action="match.accept"]').evaluate('(e)=>e.disabled=true')
    disabled = inspect()
    assert not next(x for x in disabled['buttons'] if x['action']=='match.accept')['enabled']
    assert not inspect({'action': 'match.accept', 'identity': disabled['identity']})['clicked']
    page.locator('[data-ix-action="match.accept"]').evaluate('(e)=>{e.disabled=false;e.after(e.cloneNode(true));}')
    assert 'match.accept' not in [x['action'] for x in inspect()['buttons']]
    page.set_content('''<div data-ix-surface="matchStart" data-ix-participant-count="2" data-ix-teams='[["11"],["22"]]'>
      <button data-ix-action="match.start">Start</button></div>''')
    assert inspect()['buttons'][0]['action']=='match.start'
    page.locator('[data-ix-surface]').evaluate('(e)=>e.setAttribute("data-ix-teams",\'[["11"]]\')')
    assert not inspect()['buttons']
    page.set_content('''<div data-ix-surface="cohostModeSelect"><div data-ix-action="match.select" data-ix-selected="false">Match</div>
      <button data-ix-action="cohostMode.getStarted">Next</button></div>''')
    assert 'cohostMode.getStarted' not in [x['action'] for x in inspect()['buttons']]
    page.locator('[data-ix-action="match.select"]').evaluate('(e)=>e.setAttribute("data-ix-selected","true")')
    assert 'cohostMode.getStarted' in [x['action'] for x in inspect()['buttons']]

    # Actual dashboard assets with controlled local responses: exercise the user
    # click, receipt wording, pending/accepted state and disconnect behavior.
    native_state={'available':True,'epoch':'test','revision':'a'*64,'scopes':[{'role':'invitee','battleId':'456'}],
                  'actions':[{'action':'match.accept','label':'קבל הזמנת באטל','enabled':True},{'action':'match.decline','label':'דחה הזמנת באטל','enabled':True}]}
    state={'connected':True,'live':True,'session':{'epoch':'test','roomId':'123'},'candidates':[],'operations':[],'events':[],
           'battle':{'id':'456','status':'pending','incoming':True},'actions':{}}
    sent=[]
    def route(r):
        path=r.request.url.split('47831',1)[1]
        if path=='/api/state': return r.fulfill(json=state)
        if path=='/api/battles': return r.fulfill(json=native_state)
        if path=='/api/battles/action':
            sent.append(r.request.post_data_json)
            return r.fulfill(json={'dispatched':True,'outcome':'awaiting_studio'})
        files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
        if path in files:
            kind={'/':'text/html','/app.js':'text/javascript','/style.css':'text/css'}[path]
            return r.fulfill(body=(ROOT/'dist'/files[path]).read_text(encoding='utf-8'),content_type=kind)
        return r.fulfill(status=404,body='')
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('http://127.0.0.1:47831/**',route)
    page.goto('http://127.0.0.1:47831/')
    accept=page.get_by_role('button',name='קבל הזמנת באטל',exact=True)
    expect(accept).to_be_enabled(timeout=10000)
    accept.click()
    expect(page.locator('#battle-controls-message')).to_contain_text('ממתינים לעדכון')
    assert len(sent)==1 and sent[0]['action']=='match.accept'
    expect(page.locator('#battle-label')).to_have_text('ממתין לאישור')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile overflow'
    state['connected']=False
    native_state.update(available=False,actions=[],scopes=[])
    expect(accept).to_have_count(0,timeout=10000)
    assert not errors,errors
    browser.close()
print('PASS: native identity/visibility/permissions, real dashboard click and mobile layout (synthetic only)')
