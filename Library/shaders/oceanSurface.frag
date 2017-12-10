#version 430 core
uniform sampler2DArray texWaveFFT;
uniform sampler3D texSlopeVariance;
uniform sampler2D texReflection; 
uniform vec2 viewport;
uniform vec4 gridSizes;
uniform vec3 eyePos;
uniform mat3 MV;
uniform vec3 sunDirection;
uniform float planetRadius;
uniform vec3 whitePoint;

in vec4 fragPos;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec3 fragNormal;

//Atmosphere
vec3 GetSolarLuminance();
vec3 GetSkyLuminance(vec3 camera, vec3 view_ray, float shadow_length, vec3 sun_direction, out vec3 transmittance);
vec3 GetSkyLuminanceToPoint(vec3 camera, vec3 point, float shadow_length, vec3 sun_direction, out vec3 transmittance);
vec3 GetSunAndSkyIlluminance(vec3 p, vec3 normal, vec3 sun_direction, out vec3 sky_irradiance);

const float M_PI = 3.14159265358979323846;

// assumes x>0
float erfc(float x) 
{
	return 2.0 * exp(-x * x) / (2.319 * x + sqrt(4.0 + 1.52 * x * x));
}

float Lambda(float cosTheta, float sigmaSq) 
{
	float v = cosTheta / sqrt((1.0 - cosTheta * cosTheta) * (2.0 * sigmaSq));
    return max(0.0, (exp(-v * v) - v * sqrt(M_PI) * erfc(v)) / (2.0 * v * sqrt(M_PI)));
	//return (exp(-v * v)) / (2.0 * v * sqrt(M_PI)); // approximate, faster formula
}

float meanFresnel(float cosThetaV, float sigmaV) 
{
	return pow(1.0 - cosThetaV, 5.0 * exp(-2.69 * sigmaV)) / (1.0 + 22.7 * pow(sigmaV, 1.5));
}

// V, N in world space
float meanFresnel(vec3 V, vec3 N, vec2 sigmaSq) 
{
    vec2 v = V.xy; // view direction in wind space
    vec2 t = v * v / (1.0 - V.z * V.z); // cos^2 and sin^2 of view direction
    float sigmaV2 = dot(t, sigmaSq); // slope variance in view direction
    return meanFresnel(dot(V, N), sqrt(sigmaV2));
}

// L, V, N, Tx, Ty in world space
float reflectedSunRadiance(vec3 L, vec3 V, vec3 N, vec3 Tx, vec3 Ty, vec2 sigmaSq) 
{
    vec3 H = normalize(L + V);
    float zetax = dot(H, Tx) / dot(H, N);
    float zetay = dot(H, Ty) / dot(H, N);

    float zL = dot(L, N); // cos of source zenith angle
    float zV = dot(V, N); // cos of receiver zenith angle
    float zH = dot(H, N); // cos of facet normal zenith angle
    float zH2 = zH * zH;

    float p = exp(-0.5 * (zetax * zetax / sigmaSq.x + zetay * zetay / sigmaSq.y)) / (2.0 * M_PI * sqrt(sigmaSq.x * sigmaSq.y));

    float tanV = atan(dot(V, Ty), dot(V, Tx));
    float cosV2 = 1.0 / (1.0 + tanV * tanV);
    float sigmaV2 = sigmaSq.x * cosV2 + sigmaSq.y * (1.0 - cosV2);

    float tanL = atan(dot(L, Ty), dot(L, Tx));
    float cosL2 = 1.0 / (1.0 + tanL * tanL);
    float sigmaL2 = sigmaSq.x * cosL2 + sigmaSq.y * (1.0 - cosL2);

    float fresnel = 0.02 + 0.98 * pow(1.0 - dot(V, H), 5.0);

    zL = max(zL, 0.01);
    zV = max(zV, 0.01);

    return fresnel * p / ((1.0 + Lambda(zL, sigmaL2) + Lambda(zV, sigmaV2)) * zV * zH2 * zH2 * 4.0);
}

void main()
{
    vec3 pos = fragPos.xyz/fragPos.w;
	vec3 toEye = normalize(eyePos - pos);
	vec3 center = vec3(0, 0, -planetRadius);
	vec3 P = pos - center;
	
	//Wave slope (layers 1,2)
    vec2 waveCoord = pos.xy;
	vec2 slopes = texture(texWaveFFT, vec3(waveCoord/gridSizes.x, 1.0)).xy;
	slopes += texture(texWaveFFT, vec3(waveCoord/gridSizes.y, 1.0)).zw;
	slopes += texture(texWaveFFT, vec3(waveCoord/gridSizes.z, 2.0)).xy;
	slopes += texture(texWaveFFT, vec3(waveCoord/gridSizes.w, 2.0)).zw;
	
	//Normals
	vec3 normal = normalize(vec3(-slopes.x, -slopes.y, 1.0));
	if(dot(toEye, normal) < 0.0) 
		normal = reflect(normal, toEye); //Reflect backfacing normals
	
	//
	float Jxx = dFdx(waveCoord.x);
	float Jxy = dFdy(waveCoord.x);
	float Jyx = dFdx(waveCoord.y);
	float Jyy = dFdy(waveCoord.y);
	float A = Jxx * Jxx + Jyx * Jyx;
	float B = Jxx * Jxy + Jyx * Jyy;
	float C = Jxy * Jxy + Jyy * Jyy;
	const float SCALE = 10.0;
	float ua = pow(A / SCALE, 0.25);
	float ub = 0.5 + 0.5 * B / sqrt(A * C);
	float uc = pow(C / SCALE, 0.25);
	vec2 sigmaSq = texture(texSlopeVariance, vec3(ua, ub, uc)).xy;
	sigmaSq = max(sigmaSq, 2e-5);

	vec3 Ty = normalize(vec3(0.0, normal.z, -normal.y));
	vec3 Tx = cross(Ty, normal);

	float fresnel = 0.02 + 0.98 * meanFresnel(toEye, normal, sigmaSq);
	vec3 Isky;
	vec3 Isun = GetSunAndSkyIlluminance(P, normal, sunDirection, Isky);
	
	vec3 outColor = vec3(0.0);
	
	//Sun contribution
    outColor += reflectedSunRadiance(sunDirection, toEye, normal, Tx, Ty, sigmaSq) * Isun/whitePoint/30000.0;
	
	//Sky and scene reflection
	vec3 ray = reflect(-toEye, normalize(vec3(normal.xy, 3.0)));
	vec3 trans;
	vec3 Lsky = GetSkyLuminance(P, ray, 0.0, sunDirection, trans);
	vec4 reflection = texture(texReflection, vec2(gl_FragCoord.x/viewport.x + normal.x*0.02, gl_FragCoord.y/viewport.y + min(-0.001, normal.y*0.02)));
	outColor += mix(fresnel * Lsky/whitePoint/30000.0, reflection.rgb, reflection.a);
    
	//Aerial perspective
	vec3 L2P = GetSkyLuminanceToPoint(eyePos - center, P, 0.0, sunDirection, trans)/whitePoint/30000.0;
	outColor = trans * outColor + L2P;
	
	//Sea contribution
    fragColor = vec4(outColor, 1.0-fresnel);
	fragNormal = normalize(MV * normal);
}