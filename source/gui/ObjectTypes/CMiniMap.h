/* Copyright (C) 2021 Wildfire Games.
 * This file is part of 0 A.D.
 *
 * 0 A.D. is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * 0 A.D. is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with 0 A.D.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef INCLUDED_MINIMAP
#define INCLUDED_MINIMAP

#include "graphics/ShaderProgramPtr.h"
#include "gui/ObjectBases/IGUIObject.h"
#include "renderer/VertexArray.h"

class CCamera;
class CMatrix3D;
class CTerrain;

class CMiniMap : public IGUIObject
{
	GUI_OBJECT(CMiniMap)
public:
	CMiniMap(CGUI& pGUI);
	virtual ~CMiniMap();

	/**
	 * @return The maximum height for unit passage in water.
	 */
	static float GetShallowPassageHeight();

protected:
	virtual void Draw();

	/**
	 * @see IGUIObject#HandleMessage()
	 */
	virtual void HandleMessage(SGUIMessage& Message);

	/**
	 * @see IGUIObject#IsMouseOver()
	 */
	virtual bool IsMouseOver() const;

	// create the minimap textures
	void CreateTextures();

	// rebuild the terrain texture map
	void RebuildTerrainTexture();

	// destroy and free any memory and textures
	void Destroy();

	void SetCameraPos();

	bool FireWorldClickEvent(int button, int clicks);

	static const CStr EventNameWorldClick;

	// the terrain we are mini-mapping
	const CTerrain* m_Terrain;

	const CCamera* m_Camera;

	//Whether or not the mouse is currently down
	bool m_Clicking;

	// minimap texture handles
	GLuint m_TerrainTexture;

	// texture data
	u32* m_TerrainData;

	// whether we need to regenerate the terrain texture
	bool m_TerrainDirty;

	// Whether to draw a black square around and under the minimap.
	CGUISimpleSetting<bool> m_Mask;

	ssize_t m_Width, m_Height;

	// map size
	ssize_t m_MapSize;

	// texture size
	GLsizei m_TextureSize;

	// 1.f if map is circular or 1.414f if square (to shrink it inside the circle)
	float m_MapScale;

	// maximal water height to allow the passage of a unit (for underwater shallows).
	float m_ShallowPassageHeight;

	float m_WaterHeight;

	void DrawTexture(CShaderProgramPtr shader, float coordMax, float angle, float x, float y, float x2, float y2) const;

	void DrawViewRect(const CMatrix3D& transform) const;

	void GetMouseWorldCoordinates(float& x, float& z) const;

	float GetAngle() const;

	VertexIndexArray m_IndexArray;
	VertexArray m_VertexArray;
	VertexArray::Attribute m_AttributePos;
	VertexArray::Attribute m_AttributeColor;

	size_t m_EntitiesDrawn;

	double m_PingDuration;
	double m_HalfBlinkDuration;
	double m_NextBlinkTime;
	bool m_BlinkState;
};

#endif // INCLUDED_MINIMAP
