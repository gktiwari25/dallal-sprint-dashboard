"""Pytest fixtures: a plain Chrome driver and an authenticated one."""
import os
import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

import auth

BASE_URL = os.environ.get("DASH_URL", "https://gktiwari25.github.io/dallal-sprint-dashboard/")
HEADLESS = os.environ.get("HEADLESS", "1") != "0"


def _make_driver():
    opts = Options()
    if HEADLESS:
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1440,900")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    d = webdriver.Chrome(options=opts)
    d.set_page_load_timeout(45)
    return d


@pytest.fixture
def driver():
    d = _make_driver()
    yield d
    d.quit()


@pytest.fixture
def auth_driver():
    """A driver already logged in (session injected into localStorage)."""
    val = auth.get_storage_value()
    if not val:
        pytest.skip("No test credentials: set TEST_SESSION, or TEST_EMAIL + TEST_PASSWORD.")
    d = _make_driver()
    try:
        d.get(BASE_URL)  # must be on the origin before localStorage is writable
        d.execute_script(
            "window.localStorage.setItem(arguments[0], arguments[1]);",
            auth.STORAGE_KEY, val,
        )
        d.get(BASE_URL)  # reload -> app boots already authenticated
        # Wait until the app shell is up and the first-load skeleton has cleared.
        WebDriverWait(d, 40).until(EC.visibility_of_element_located((By.ID, "topbar")))
        WebDriverWait(d, 40).until(
            lambda x: x.find_element(By.ID, "sprintView").is_displayed()
            and not x.find_element(By.ID, "loadSkeleton").is_displayed()
        )
        yield d
    finally:
        d.quit()
