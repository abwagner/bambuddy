from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.spool import Spool


async def test_barcode_lookup_returns_newest_local_sku_template(
    async_client: AsyncClient,
    db_session: AsyncSession,
):
    first = Spool(material="PLA", brand="Acme", color_name="Old red", barcode="0123456789012")
    newest = Spool(
        material="PETG",
        subtype="HF",
        brand="Acme",
        color_name="Ocean",
        rgba="112233FF",
        label_weight=1000,
        barcode="0123456789012",
        slicer_filament="GFG96",
        slicer_filament_name="Generic PETG HF",
    )
    db_session.add_all([first, newest])
    await db_session.commit()

    response = await async_client.get(
        "/api/v1/inventory/spools/by-barcode",
        params={"barcode": "0123456789012"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == newest.id
    assert body["material"] == "PETG"
    assert body["barcode"] == "0123456789012"
    assert body["slicer_filament"] == "GFG96"


async def test_unknown_barcode_is_a_normal_404(async_client: AsyncClient):
    response = await async_client.get(
        "/api/v1/inventory/spools/by-barcode",
        params={"barcode": "not-learned-yet"},
    )
    assert response.status_code == 404


async def test_create_spool_learns_barcode(async_client: AsyncClient):
    created = await async_client.post(
        "/api/v1/inventory/spools",
        json={
            "material": "PLA",
            "brand": "Local Brand",
            "barcode": "  9988776655  ",
            "rgba": "AABBCCFF",
        },
    )
    assert created.status_code == 200
    assert created.json()["barcode"] == "9988776655"

    found = await async_client.get(
        "/api/v1/inventory/spools/by-barcode",
        params={"barcode": "9988776655"},
    )
    assert found.status_code == 200
    assert found.json()["brand"] == "Local Brand"
