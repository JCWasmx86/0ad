/* Copyright (C) 2022 Wildfire Games.
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

#include "precompiled.h"

#include "renderer/PostprocManager.h"

#include "graphics/GameView.h"
#include "graphics/LightEnv.h"
#include "graphics/ShaderManager.h"
#include "lib/bits.h"
#include "lib/ogl.h"
#include "maths/MathUtil.h"
#include "ps/ConfigDB.h"
#include "ps/CLogger.h"
#include "ps/CStrInternStatic.h"
#include "ps/Filesystem.h"
#include "ps/Game.h"
#include "ps/VideoMode.h"
#include "ps/World.h"
#include "renderer/backend/gl/Device.h"
#include "renderer/Renderer.h"
#include "renderer/RenderingOptions.h"
#include "tools/atlas/GameInterface/GameLoop.h"

#if !CONFIG2_GLES

CPostprocManager::CPostprocManager()
	: m_IsInitialized(false), m_PostProcEffect(L"default"), m_WhichBuffer(true),
	m_Sharpness(0.3f), m_UsingMultisampleBuffer(false), m_MultisampleCount(0)
{
}

CPostprocManager::~CPostprocManager()
{
	Cleanup();
}

bool CPostprocManager::IsEnabled() const
{
	return g_RenderingOptions.GetPostProc() &&
		g_VideoMode.GetBackend() != CVideoMode::Backend::GL_ARB;
}

void CPostprocManager::Cleanup()
{
	if (!m_IsInitialized) // Only cleanup if previously used
		return;

	m_CaptureFramebuffer.reset();

	m_PingFramebuffer.reset();
	m_PongFramebuffer.reset();

	m_ColorTex1.reset();
	m_ColorTex2.reset();
	m_DepthTex.reset();

	for (BlurScale& scale : m_BlurScales)
	{
		for (BlurScale::Step& step : scale.steps)
		{
			step.framebuffer.reset();
			step.texture.reset();
		}
	}
}

void CPostprocManager::Initialize()
{
	if (m_IsInitialized)
		return;

	const uint32_t maxSamples = g_VideoMode.GetBackendDevice()->GetCapabilities().maxSampleCount;
	const uint32_t possibleSampleCounts[] = {2, 4, 8, 16};
	std::copy_if(
		std::begin(possibleSampleCounts), std::end(possibleSampleCounts),
		std::back_inserter(m_AllowedSampleCounts),
		[maxSamples](const uint32_t sampleCount) { return sampleCount <= maxSamples; } );

	// The screen size starts out correct and then must be updated with Resize()
	m_Width = g_Renderer.GetWidth();
	m_Height = g_Renderer.GetHeight();

	RecreateBuffers();
	m_IsInitialized = true;

	// Once we have initialised the buffers, we can update the techniques.
	UpdateAntiAliasingTechnique();
	UpdateSharpeningTechnique();
	UpdateSharpnessFactor();

	// This might happen after the map is loaded and the effect chosen
	SetPostEffect(m_PostProcEffect);
}

void CPostprocManager::Resize()
{
	m_Width = g_Renderer.GetWidth();
	m_Height = g_Renderer.GetHeight();

	// If the buffers were intialized, recreate them to the new size.
	if (m_IsInitialized)
		RecreateBuffers();
}

void CPostprocManager::RecreateBuffers()
{
	Cleanup();

	#define GEN_BUFFER_RGBA(name, w, h) \
		name = g_VideoMode.GetBackendDevice()->CreateTexture2D( \
			"PostProc" #name, Renderer::Backend::Format::R8G8B8A8, w, h, \
			Renderer::Backend::Sampler::MakeDefaultSampler( \
				Renderer::Backend::Sampler::Filter::LINEAR, \
				Renderer::Backend::Sampler::AddressMode::CLAMP_TO_EDGE));

	// Two fullscreen ping-pong textures.
	GEN_BUFFER_RGBA(m_ColorTex1, m_Width, m_Height);
	GEN_BUFFER_RGBA(m_ColorTex2, m_Width, m_Height);

	// Textures for several blur sizes. It would be possible to reuse
	// m_BlurTex2b, thus avoiding the need for m_BlurTex4b and m_BlurTex8b, though given
	// that these are fairly small it's probably not worth complicating the coordinates passed
	// to the blur helper functions.
	uint32_t width = m_Width / 2, height = m_Height / 2;
	for (BlurScale& scale : m_BlurScales)
	{
		for (BlurScale::Step& step : scale.steps)
		{
			GEN_BUFFER_RGBA(step.texture, width, height);
			step.framebuffer = Renderer::Backend::GL::CFramebuffer::Create(
				step.texture.get(), nullptr);
		}
		width /= 2;
		height /= 2;
	}

	#undef GEN_BUFFER_RGBA

	// Allocate the Depth/Stencil texture.
	m_DepthTex = g_VideoMode.GetBackendDevice()->CreateTexture2D("PostPRocDepthTexture",
		Renderer::Backend::Format::D24_S8, m_Width, m_Height,
		Renderer::Backend::Sampler::MakeDefaultSampler(
			Renderer::Backend::Sampler::Filter::LINEAR,
			Renderer::Backend::Sampler::AddressMode::CLAMP_TO_EDGE));

	g_Renderer.GetDeviceCommandContext()->BindTexture(0, GL_TEXTURE_2D, m_DepthTex->GetHandle());
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_NONE);
	g_Renderer.GetDeviceCommandContext()->BindTexture(0, GL_TEXTURE_2D, 0);

	// Set up the framebuffers with some initial textures.
	m_CaptureFramebuffer = Renderer::Backend::GL::CFramebuffer::Create(
		m_ColorTex1.get(), m_DepthTex.get(),
		g_VideoMode.GetBackendDevice()->GetCurrentBackbuffer()->GetClearColor());

	m_PingFramebuffer = Renderer::Backend::GL::CFramebuffer::Create(
		m_ColorTex1.get(), nullptr);
	m_PongFramebuffer = Renderer::Backend::GL::CFramebuffer::Create(
		m_ColorTex2.get(), nullptr);

	if (!m_CaptureFramebuffer || !m_PingFramebuffer || !m_PongFramebuffer)
	{
		LOGWARNING("Failed to create postproc framebuffers");
		g_RenderingOptions.SetPostProc(false);
	}

	if (m_UsingMultisampleBuffer)
	{
		DestroyMultisampleBuffer();
		CreateMultisampleBuffer();
	}
}


void CPostprocManager::ApplyBlurDownscale2x(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext,
	Renderer::Backend::GL::CFramebuffer* framebuffer,
	Renderer::Backend::GL::CTexture* inTex, int inWidth, int inHeight)
{
	deviceCommandContext->SetFramebuffer(framebuffer);

	// Get bloom shader with instructions to simply copy texels.
	CShaderDefines defines;
	defines.Add(str_BLOOM_NOP, str_1);
	CShaderTechniquePtr tech = g_Renderer.GetShaderManager().LoadEffect(str_bloom, defines);

	tech->BeginPass();
	deviceCommandContext->SetGraphicsPipelineState(
		tech->GetGraphicsPipelineStateDesc());
	const CShaderProgramPtr& shader = tech->GetShader();

	shader->BindTexture(str_renderedTex, inTex);

	const SViewPort oldVp = g_Renderer.GetViewport();
	const SViewPort vp = { 0, 0, inWidth / 2, inHeight / 2 };
	g_Renderer.SetViewport(vp);

	float quadVerts[] =
	{
		1.0f, 1.0f,
		-1.0f, 1.0f,
		-1.0f, -1.0f,

		-1.0f, -1.0f,
		1.0f, -1.0f,
		1.0f, 1.0f
	};
	float quadTex[] =
	{
		1.0f, 1.0f,
		0.0f, 1.0f,
		0.0f, 0.0f,

		0.0f, 0.0f,
		1.0f, 0.0f,
		1.0f, 1.0f
	};
	shader->TexCoordPointer(GL_TEXTURE0, 2, GL_FLOAT, 0, quadTex);
	shader->VertexPointer(2, GL_FLOAT, 0, quadVerts);
	shader->AssertPointersBound();
	glDrawArrays(GL_TRIANGLES, 0, 6);

	g_Renderer.SetViewport(oldVp);

	tech->EndPass();
}

void CPostprocManager::ApplyBlurGauss(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext,
	Renderer::Backend::GL::CTexture* inTex,
	Renderer::Backend::GL::CTexture* tempTex,
	Renderer::Backend::GL::CFramebuffer* tempFramebuffer,
	Renderer::Backend::GL::CFramebuffer* outFramebuffer,
	int inWidth, int inHeight)
{
	deviceCommandContext->SetFramebuffer(tempFramebuffer);

	// Get bloom shader, for a horizontal Gaussian blur pass.
	CShaderDefines defines2;
	defines2.Add(str_BLOOM_PASS_H, str_1);
	CShaderTechniquePtr tech = g_Renderer.GetShaderManager().LoadEffect(str_bloom, defines2);

	tech->BeginPass();
	deviceCommandContext->SetGraphicsPipelineState(
		tech->GetGraphicsPipelineStateDesc());
	CShaderProgramPtr shader = tech->GetShader();
	shader->BindTexture(str_renderedTex, inTex);
	shader->Uniform(str_texSize, inWidth, inHeight, 0.0f, 0.0f);

	const SViewPort oldVp = g_Renderer.GetViewport();
	const SViewPort vp = { 0, 0, inWidth, inHeight };
	g_Renderer.SetViewport(vp);

	float quadVerts[] =
	{
		1.0f, 1.0f,
		-1.0f, 1.0f,
		-1.0f, -1.0f,

		-1.0f, -1.0f,
		1.0f, -1.0f,
		1.0f, 1.0f
	};
	float quadTex[] =
	{
		1.0f, 1.0f,
		0.0f, 1.0f,
		0.0f, 0.0f,

		0.0f, 0.0f,
		1.0f, 0.0f,
		1.0f, 1.0f
	};
	shader->TexCoordPointer(GL_TEXTURE0, 2, GL_FLOAT, 0, quadTex);
	shader->VertexPointer(2, GL_FLOAT, 0, quadVerts);
	shader->AssertPointersBound();
	glDrawArrays(GL_TRIANGLES, 0, 6);

	g_Renderer.SetViewport(oldVp);

	tech->EndPass();

	deviceCommandContext->SetFramebuffer(outFramebuffer);

	// Get bloom shader, for a vertical Gaussian blur pass.
	CShaderDefines defines3;
	defines3.Add(str_BLOOM_PASS_V, str_1);
	tech = g_Renderer.GetShaderManager().LoadEffect(str_bloom, defines3);

	tech->BeginPass();
	shader = tech->GetShader();

	// Our input texture to the shader is the output of the horizontal pass.
	shader->BindTexture(str_renderedTex, tempTex);
	shader->Uniform(str_texSize, inWidth, inHeight, 0.0f, 0.0f);

	g_Renderer.SetViewport(vp);

	shader->TexCoordPointer(GL_TEXTURE0, 2, GL_FLOAT, 0, quadTex);
	shader->VertexPointer(2, GL_FLOAT, 0, quadVerts);
	shader->AssertPointersBound();
	glDrawArrays(GL_TRIANGLES, 0, 6);

	g_Renderer.SetViewport(oldVp);

	tech->EndPass();
}

void CPostprocManager::ApplyBlur(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext)
{
	uint32_t width = m_Width, height = m_Height;
	Renderer::Backend::GL::CTexture* previousTexture =
		(m_WhichBuffer ? m_ColorTex1 : m_ColorTex2).get();

	for (BlurScale& scale : m_BlurScales)
	{
		ApplyBlurDownscale2x(deviceCommandContext, scale.steps[0].framebuffer.get(), previousTexture, width, height);
		width /= 2;
		height /= 2;
		ApplyBlurGauss(deviceCommandContext, scale.steps[0].texture.get(),
			scale.steps[1].texture.get(), scale.steps[1].framebuffer.get(),
			scale.steps[0].framebuffer.get(), width, height);
	}
}


void CPostprocManager::CaptureRenderOutput(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext)
{
	ENSURE(m_IsInitialized);

	// Leaves m_PingFbo selected for rendering; m_WhichBuffer stays true at this point.

	if (m_UsingMultisampleBuffer)
		deviceCommandContext->SetFramebuffer(m_MultisampleFramebuffer.get());
	else
		deviceCommandContext->SetFramebuffer(m_CaptureFramebuffer.get());

	m_WhichBuffer = true;
}


void CPostprocManager::ReleaseRenderOutput(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext)
{
	ENSURE(m_IsInitialized);

	// We blit to the backbuffer from the previous active buffer.
	deviceCommandContext->BlitFramebuffer(
		deviceCommandContext->GetDevice()->GetCurrentBackbuffer(),
		(m_WhichBuffer ? m_PingFramebuffer : m_PongFramebuffer).get());

	deviceCommandContext->SetFramebuffer(
		deviceCommandContext->GetDevice()->GetCurrentBackbuffer());
}

void CPostprocManager::ApplyEffect(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext,
	const CShaderTechniquePtr& shaderTech, int pass)
{
	// select the other FBO for rendering
	deviceCommandContext->SetFramebuffer(
		(m_WhichBuffer ? m_PongFramebuffer : m_PingFramebuffer).get());

	shaderTech->BeginPass(pass);
	deviceCommandContext->SetGraphicsPipelineState(
		shaderTech->GetGraphicsPipelineStateDesc(pass));
	const CShaderProgramPtr& shader = shaderTech->GetShader(pass);

	// Use the textures from the current FBO as input to the shader.
	// We also bind a bunch of other textures and parameters, but since
	// this only happens once per frame the overhead is negligible.
	if (m_WhichBuffer)
		shader->BindTexture(str_renderedTex, m_ColorTex1.get());
	else
		shader->BindTexture(str_renderedTex, m_ColorTex2.get());

	shader->BindTexture(str_depthTex, m_DepthTex.get());

	shader->BindTexture(str_blurTex2, m_BlurScales[0].steps[0].texture.get());
	shader->BindTexture(str_blurTex4, m_BlurScales[1].steps[0].texture.get());
	shader->BindTexture(str_blurTex8, m_BlurScales[2].steps[0].texture.get());

	shader->Uniform(str_width, m_Width);
	shader->Uniform(str_height, m_Height);
	shader->Uniform(str_zNear, m_NearPlane);
	shader->Uniform(str_zFar, m_FarPlane);

	shader->Uniform(str_sharpness, m_Sharpness);

	shader->Uniform(str_brightness, g_LightEnv.m_Brightness);
	shader->Uniform(str_hdr, g_LightEnv.m_Contrast);
	shader->Uniform(str_saturation, g_LightEnv.m_Saturation);
	shader->Uniform(str_bloom, g_LightEnv.m_Bloom);

	float quadVerts[] =
	{
		1.0f, 1.0f,
		-1.0f, 1.0f,
		-1.0f, -1.0f,

		-1.0f, -1.0f,
		1.0f, -1.0f,
		1.0f, 1.0f
	};
	float quadTex[] =
	{
		1.0f, 1.0f,
		0.0f, 1.0f,
		0.0f, 0.0f,

		0.0f, 0.0f,
		1.0f, 0.0f,
		1.0f, 1.0f
	};
	shader->TexCoordPointer(GL_TEXTURE0, 2, GL_FLOAT, 0, quadTex);
	shader->VertexPointer(2, GL_FLOAT, 0, quadVerts);
	shader->AssertPointersBound();
	glDrawArrays(GL_TRIANGLES, 0, 6);

	shaderTech->EndPass(pass);

	m_WhichBuffer = !m_WhichBuffer;
}

void CPostprocManager::ApplyPostproc(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext)
{
	ENSURE(m_IsInitialized);

	// Don't do anything if we are using the default effect and no AA.
	const bool hasEffects = m_PostProcEffect != L"default";
	const bool hasARB = g_VideoMode.GetBackend() == CVideoMode::Backend::GL_ARB;
	const bool hasAA = m_AATech && !hasARB;
	const bool hasSharp = m_SharpTech && !hasARB;
	if (!hasEffects && !hasAA && !hasSharp)
		return;

	if (hasEffects)
	{
		// First render blur textures. Note that this only happens ONLY ONCE, before any effects are applied!
		// (This may need to change depending on future usage, however that will have a fps hit)
		ApplyBlur(deviceCommandContext);
		for (int pass = 0; pass < m_PostProcTech->GetNumPasses(); ++pass)
			ApplyEffect(deviceCommandContext, m_PostProcTech, pass);
	}

	if (hasAA)
	{
		for (int pass = 0; pass < m_AATech->GetNumPasses(); ++pass)
			ApplyEffect(deviceCommandContext, m_AATech, pass);
	}

	if (hasSharp)
	{
		for (int pass = 0; pass < m_SharpTech->GetNumPasses(); ++pass)
			ApplyEffect(deviceCommandContext, m_SharpTech, pass);
	}
}


// Generate list of available effect-sets
std::vector<CStrW> CPostprocManager::GetPostEffects()
{
	std::vector<CStrW> effects;

	const VfsPath folder(L"shaders/effects/postproc/");

	VfsPaths pathnames;
	if (vfs::GetPathnames(g_VFS, folder, 0, pathnames) < 0)
		LOGERROR("Error finding Post effects in '%s'", folder.string8());

	for (const VfsPath& path : pathnames)
		if (path.Extension() == L".xml")
			effects.push_back(path.Basename().string());

	// Add the default "null" effect to the list.
	effects.push_back(L"default");

	sort(effects.begin(), effects.end());

	return effects;
}

void CPostprocManager::SetPostEffect(const CStrW& name)
{
	if (m_IsInitialized)
	{
		if (name != L"default")
		{
			CStrW n = L"postproc/" + name;
			m_PostProcTech = g_Renderer.GetShaderManager().LoadEffect(CStrIntern(n.ToUTF8()));
		}
	}

	m_PostProcEffect = name;
}

void CPostprocManager::UpdateAntiAliasingTechnique()
{
	if (g_VideoMode.GetBackend() == CVideoMode::Backend::GL_ARB || !m_IsInitialized)
		return;

	CStr newAAName;
	CFG_GET_VAL("antialiasing", newAAName);
	if (m_AAName == newAAName)
		return;
	m_AAName = newAAName;
	m_AATech.reset();

	if (m_UsingMultisampleBuffer)
	{
		m_UsingMultisampleBuffer = false;
		DestroyMultisampleBuffer();
	}

	// We have to hardcode names in the engine, because anti-aliasing
	// techinques strongly depend on the graphics pipeline.
	// We might use enums in future though.
	const CStr msaaPrefix = "msaa";
	if (m_AAName == "fxaa")
	{
		m_AATech = g_Renderer.GetShaderManager().LoadEffect(CStrIntern("fxaa"));
	}
	else if (m_AAName.size() > msaaPrefix.size() && m_AAName.substr(0, msaaPrefix.size()) == msaaPrefix)
	{
		// We don't want to enable MSAA in Atlas, because it uses wxWidgets and its canvas.
		if (g_AtlasGameLoop && g_AtlasGameLoop->running)
			return;
		if (!g_VideoMode.GetBackendDevice()->GetCapabilities().multisampling && !m_AllowedSampleCounts.empty())
		{
			LOGWARNING("MSAA is unsupported.");
			return;
		}
		std::stringstream ss(m_AAName.substr(msaaPrefix.size()));
		ss >> m_MultisampleCount;
		if (std::find(std::begin(m_AllowedSampleCounts), std::end(m_AllowedSampleCounts), m_MultisampleCount) ==
		        std::end(m_AllowedSampleCounts))
		{
			m_MultisampleCount = 4;
			LOGWARNING("Wrong MSAA sample count: %s.", m_AAName.EscapeToPrintableASCII().c_str());
		}
		m_UsingMultisampleBuffer = true;
		CreateMultisampleBuffer();
	}
}

void CPostprocManager::UpdateSharpeningTechnique()
{
	if (g_VideoMode.GetBackend() == CVideoMode::Backend::GL_ARB || !m_IsInitialized)
		return;

	CStr newSharpName;
	CFG_GET_VAL("sharpening", newSharpName);
	if (m_SharpName == newSharpName)
		return;
	m_SharpName = newSharpName;
	m_SharpTech.reset();

	if (m_SharpName == "cas")
	{
		m_SharpTech = g_Renderer.GetShaderManager().LoadEffect(CStrIntern(m_SharpName));
	}
}

void CPostprocManager::UpdateSharpnessFactor()
{
	CFG_GET_VAL("sharpness", m_Sharpness);
}

void CPostprocManager::SetDepthBufferClipPlanes(float nearPlane, float farPlane)
{
	m_NearPlane = nearPlane;
	m_FarPlane = farPlane;
}

void CPostprocManager::CreateMultisampleBuffer()
{
	glEnable(GL_MULTISAMPLE);

	m_MultisampleColorTex = g_VideoMode.GetBackendDevice()->CreateTexture("PostProcColorMS",
		Renderer::Backend::GL::CTexture::Type::TEXTURE_2D_MULTISAMPLE,
		Renderer::Backend::Format::R8G8B8A8, m_Width, m_Height,
		Renderer::Backend::Sampler::MakeDefaultSampler(
			Renderer::Backend::Sampler::Filter::LINEAR,
			Renderer::Backend::Sampler::AddressMode::CLAMP_TO_EDGE), 1, m_MultisampleCount);

	// Allocate the Depth/Stencil texture.
	m_MultisampleDepthTex = g_VideoMode.GetBackendDevice()->CreateTexture("PostProcDepthMS",
		Renderer::Backend::GL::CTexture::Type::TEXTURE_2D_MULTISAMPLE,
		Renderer::Backend::Format::D24_S8, m_Width, m_Height,
		Renderer::Backend::Sampler::MakeDefaultSampler(
			Renderer::Backend::Sampler::Filter::LINEAR,
			Renderer::Backend::Sampler::AddressMode::CLAMP_TO_EDGE), 1, m_MultisampleCount);

	// Set up the framebuffers with some initial textures.
	m_MultisampleFramebuffer = Renderer::Backend::GL::CFramebuffer::Create(
		m_MultisampleColorTex.get(), m_MultisampleDepthTex.get(),
		g_VideoMode.GetBackendDevice()->GetCurrentBackbuffer()->GetClearColor());

	if (!m_MultisampleFramebuffer)
	{
		LOGERROR("Failed to create postproc multisample framebuffer");
		m_UsingMultisampleBuffer = false;
		DestroyMultisampleBuffer();
	}
}

void CPostprocManager::DestroyMultisampleBuffer()
{
	if (m_UsingMultisampleBuffer)
		return;
	m_MultisampleFramebuffer.reset();
	m_MultisampleColorTex.reset();
	m_MultisampleDepthTex.reset();
	glDisable(GL_MULTISAMPLE);
}

bool CPostprocManager::IsMultisampleEnabled() const
{
	return m_UsingMultisampleBuffer;
}

void CPostprocManager::ResolveMultisampleFramebuffer(
	Renderer::Backend::GL::CDeviceCommandContext* deviceCommandContext)
{
	if (!m_UsingMultisampleBuffer)
		return;

	deviceCommandContext->BlitFramebuffer(
		m_PingFramebuffer.get(), m_MultisampleFramebuffer.get());
	deviceCommandContext->SetFramebuffer(m_PingFramebuffer.get());
}

#else

#warning TODO: implement PostprocManager for GLES

void ApplyBlurDownscale2x(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext),
	Renderer::Backend::GL::CFramebuffer* UNUSED(framebuffer),
	Renderer::Backend::GL::CTexture* UNUSED(inTex),
	int UNUSED(inWidth), int UNUSED(inHeight))
{
}

void CPostprocManager::ApplyBlurGauss(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext),
	Renderer::Backend::GL::CTexture* UNUSED(inTex),
	Renderer::Backend::GL::CTexture* UNUSED(tempTex),
	Renderer::Backend::GL::CFramebuffer* UNUSED(tempFramebuffer),
	Renderer::Backend::GL::CFramebuffer* UNUSED(outFramebuffer),
	int UNUSED(inWidth), int UNUSED(inHeight))
{
}

void CPostprocManager::ApplyEffect(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext),
	const CShaderTechniquePtr& UNUSED(shaderTech), int UNUSED(pass))
{
}

CPostprocManager::CPostprocManager()
{
}

CPostprocManager::~CPostprocManager()
{
}

bool CPostprocManager::IsEnabled() const
{
	return false;
}

void CPostprocManager::Initialize()
{
}

void CPostprocManager::Resize()
{
}

void CPostprocManager::Cleanup()
{
}

void CPostprocManager::RecreateBuffers()
{
}

std::vector<CStrW> CPostprocManager::GetPostEffects()
{
	return std::vector<CStrW>();
}

void CPostprocManager::SetPostEffect(const CStrW& UNUSED(name))
{
}

void CPostprocManager::SetDepthBufferClipPlanes(float UNUSED(nearPlane), float UNUSED(farPlane))
{
}

void CPostprocManager::UpdateAntiAliasingTechnique()
{
}

void CPostprocManager::UpdateSharpeningTechnique()
{
}

void CPostprocManager::UpdateSharpnessFactor()
{
}

void CPostprocManager::CaptureRenderOutput(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext))
{
}

void CPostprocManager::ApplyPostproc(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext))
{
}

void CPostprocManager::ReleaseRenderOutput(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext))
{
}

void CPostprocManager::CreateMultisampleBuffer()
{
}

void CPostprocManager::DestroyMultisampleBuffer()
{
}

bool CPostprocManager::IsMultisampleEnabled() const
{
	return false;
}

void CPostprocManager::ResolveMultisampleFramebuffer(
	Renderer::Backend::GL::CDeviceCommandContext* UNUSED(deviceCommandContext))
{
}

#endif
