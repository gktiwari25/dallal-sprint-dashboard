"""
End-to-end UI tests for the Dallal sprint dashboard.

Unauthenticated tests run anywhere. Authenticated tests need a session
(see auth.py / README) and are skipped otherwise.
"""
import os
import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE_URL = os.environ.get("DASH_URL", "https://gktiwari25.github.io/dallal-sprint-dashboard/")


# ---------- helpers ----------
def wait(d, cond, t=30):
    return WebDriverWait(d, t).until(cond)


def visible(d, id_):
    try:
        return d.find_element(By.ID, id_).is_displayed()
    except Exception:
        return False


def click(d, id_):
    """Scroll the element to center and click; fall back to a JS click if another
    element (sticky header / overlapping card) intercepts the pointer."""
    el = d.find_element(By.ID, id_)
    d.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    try:
        el.click()
    except Exception:
        d.execute_script("arguments[0].click();", el)
    return el


def select_sprint(d, n):
    """Set the sprint dropdown to sprint n and fire change so the app re-renders."""
    d.execute_script(
        """
        var s = document.getElementById('sprintSel');
        var v = String(arguments[0]);
        for (var i=0;i<s.options.length;i++){ if(s.options[i].value===v){ s.selectedIndex=i; break; } }
        s.dispatchEvent(new Event('change'));
        """,
        n,
    )


# ---------- unauthenticated ----------
def test_login_screen_renders(driver):
    driver.get(BASE_URL)
    wait(driver, EC.presence_of_element_located((By.ID, "ctaLogin")))
    assert driver.title == "Dallal Internal Dashboard"
    assert visible(driver, "login")
    assert driver.find_element(By.ID, "ctaLogin").is_displayed()


def test_app_hidden_when_logged_out(driver):
    driver.get(BASE_URL)
    wait(driver, EC.presence_of_element_located((By.ID, "login")))
    # The data app must not be exposed without auth.
    assert not visible(driver, "app")


# ---------- authenticated ----------
def test_dashboard_loads_and_skeleton_clears(auth_driver):
    d = auth_driver
    assert visible(d, "topbar")
    assert visible(d, "sprintView"), "content view should be revealed after load"
    assert not visible(d, "loadSkeleton"), "skeleton must not stay stuck"
    # Sprint selector is populated.
    opts = d.find_elements(By.CSS_SELECTOR, "#sprintSel option")
    assert len(opts) > 0, "sprint dropdown should have options"


def test_sprint_health_renders(auth_driver):
    d = auth_driver
    wait(d, lambda x: x.find_element(By.ID, "healthGrid").text.strip() != "")
    hero_titles = d.find_elements(By.CSS_SELECTOR, "#healthGrid .hcard-title")
    assert len(hero_titles) >= 1


def test_info_icon_inline_with_title(auth_driver):
    """The Sprint Health hero 'i' tip must sit on the same line as its title
    (regression: it was wrapping to a new line and looked like it dropped)."""
    d = auth_driver
    wait(d, lambda x: x.find_elements(By.CSS_SELECTOR, "#healthGrid .hcard-title .tip"))
    ok = d.execute_script(
        """
        var t = document.querySelector('#healthGrid .hcard-title');
        var i = t && t.querySelector('.tip');
        if(!i) return true;
        var tr = t.getBoundingClientRect(), ir = i.getBoundingClientRect();
        // tip's vertical center within the title's box = same line
        var ic = ir.top + ir.height/2;
        return ic >= tr.top - 2 && ic <= tr.bottom + 2;
        """
    )
    assert ok, "info icon wrapped below its title"


@pytest.mark.parametrize("tab_id,view_id", [
    ("tabDelivery", "sprintView"),
    ("tabAppStore", "appstoreView"),
    ("tabFunnels", "funnelView"),
    ("tabEng", "engView"),
])
def test_top_tabs_switch(auth_driver, tab_id, view_id):
    d = auth_driver
    d.find_element(By.ID, tab_id).click()
    wait(d, lambda x: x.find_element(By.ID, view_id).is_displayed())
    assert visible(d, view_id)


def test_ready_for_uat_subtabs(auth_driver):
    d = auth_driver
    d.find_element(By.ID, "tabDelivery").click()
    select_sprint(d, 15)  # a sprint with UAT sends
    # Both sub-tabs exist.
    assert d.find_element(By.ID, "uatTabCurrent").is_displayed()
    assert d.find_element(By.ID, "uatTabSent").is_displayed()
    # Switch to the throughput tab.
    click(d, "uatTabSent")
    wait(d, lambda x: "throughput" in x.find_element(By.ID, "uatIntro").text.lower())
    assert "Sent" == d.find_element(By.ID, "uatRangeLabel").text
    # The "Sent to UAT" stat card renders.
    wait(d, lambda x: "Sent to UAT" in x.find_element(By.ID, "uatGrid").text)


def test_sends_list_collapsed_by_default(auth_driver):
    d = auth_driver
    d.find_element(By.ID, "tabDelivery").click()
    select_sprint(d, 15)
    click(d, "uatTabSent")
    wait(d, lambda x: "Sent to UAT" in x.find_element(By.ID, "uatGrid").text)
    # If a Sends event block rendered, it must start collapsed (no `open` attr).
    blocks = d.find_elements(By.CSS_SELECTOR, '#uatList details[data-lb="uat-sent-list"]')
    if blocks:
        assert blocks[0].get_attribute("open") is None, "Sends list should be collapsed by default"


def test_quality_reopened_list(auth_driver):
    d = auth_driver
    d.find_element(By.ID, "tabDelivery").click()
    select_sprint(d, 14)  # a sprint with reopened tickets
    wait(d, lambda x: x.find_element(By.ID, "reopenedList").text.strip() != "")
    assert "REOPENED TICKETS" in d.find_element(By.ID, "reopenedList").text
